"use strict";

const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");
const { chromium } = require("playwright");
const { parseUbl } = require("./ubl");

const CONSULTA_URL =
  process.env.SUNAT_CONSULTA_URL ||
  "https://ww1.sunat.gob.pe/ol-ti-itconscpemype/consultar.do";
const CONSULTA_REFERER =
  process.env.SUNAT_CONSULTA_REFERER || CONSULTA_URL;
const MENU_URLS = [
  process.env.SUNAT_MENU_URL ||
    "https://e-menu.sunat.gob.pe/cl-ti-itmenu/MenuInternet.htm",
  "https://e-menu.sunat.gob.pe/cl-ti-itmenucabina/MenuInternet.htm",
];
const STATE_TTL_MS = Number(process.env.SUNAT_STATE_TTL_MS || 10 * 60 * 1000);
const SIRE_API = "https://api-sire.sunat.gob.pe/v1/contribuyente/migeigv/libros";
const CONSULTACPE_API =
  "https://api-cpe.sunat.gob.pe/v1/contribuyente/consultacpe/comprobantes";
const BUZON_BASE =
  process.env.SUNAT_BUZON_URL || "https://ww1.sunat.gob.pe/ol-ti-itvisornoti/visor";
const BUZON_MENU_URL =
  process.env.SUNAT_BUZON_MENU_URL ||
  "https://e-menu.sunat.gob.pe/cl-ti-itmenu/MenuInternet.htm?action=buzon&s=ww1";
const BUZON_DETAIL_ROUTE = "**/ol-ti-itvisornoti/visor/obtenerDetalleNoti*";
const TIPOS_RECIBIDOS = new Set(["11", "14", "16"]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const TIPOS = {
  10: "Facturas emitidas",
  11: "Facturas recibidas",
  12: "Facturas rechazadas",
  13: "Notas de crédito emitidas",
  14: "Notas de crédito recibidas",
  15: "Notas de débito emitidas",
  16: "Notas de débito recibidas",
};

const TIPO_LABELS = {
  "01": "Factura",
  "03": "Boleta",
  "07": "Nota de crédito",
  "08": "Nota de débito",
};

const DOCUMENTOS = {
  factura: "Facturas",
  boleta: "Boletas",
};

// SUNAT responde con codeError != 0 cuando no hay resultados (por ejemplo en
// "Facturas recibidas" si el periodo no tiene comprobantes). No es un fallo de
// la consulta: el listado simplemente está vacío.
const SIN_RESULTADOS_RE =
  /no\s+(?:se\s+)?(?:encontr|existen|hay|existe)|sin\s+(?:resultados|registros|comprobantes|informaci[oó]n)|no\s+existen\s+(?:registros|comprobantes|documentos|informaci[oó]n)/i;

/**
 * El código 10-16 es el mismo para el módulo de facturas y el de boletas;
 * solo cambia el módulo que se abre en el menú de SUNAT.
 */
function tipoLabel(tipo, documento = "factura") {
  const label = TIPOS[tipo] || String(tipo);
  return documento === "boleta" ? label.replace(/^Facturas/, "Boletas") : label;
}

function decodeEntities(value) {
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function toNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(String(value).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function freshState(statePath) {
  if (!statePath || !fs.existsSync(statePath)) return false;
  try {
    return Date.now() - fs.statSync(statePath).mtimeMs < STATE_TTL_MS;
  } catch {
    return false;
  }
}

function normalizeKey(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function menuTextRegex(label) {
  const words = String(label)
    .replace(/\s*[-–]\s*/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) =>
      word
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/[áÁ]/g, "[áa]")
        .replace(/[éÉ]/g, "[ée]")
        .replace(/[íÍ]/g, "[íi]")
        .replace(/[óÓ]/g, "[óo]")
        .replace(/[úÚ]/g, "[úu]")
        .replace(/[ñÑ]/g, "[ñn]"),
    );

  return new RegExp(words.join("\\s*[-–]?\\s*"), "i");
}

function sireValue(row, ...names) {
  const entries = Object.entries(row || {});
  for (const name of names) {
    const wanted = normalizeKey(name);
    const match = entries.find(([key]) => normalizeKey(key) === wanted);
    if (match && String(match[1]).trim() !== "") return String(match[1]).trim();
  }
  return "";
}

function toSireNumber(value) {
  const parsed = Number(String(value || "").replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeInvoice(raw) {
  const map = {};
  Object.entries(raw || {}).forEach(([key, value]) => {
    map[String(key).toLowerCase()] = value;
  });

  const pick = (...keys) => {
    for (const key of keys) {
      const value = map[key.toLowerCase()];
      if (value !== undefined && value !== null && value !== "") return value;
    }
    return null;
  };

  const tipo = String(
    pick("codFactura", "codTipoComprobante", "tipoComprobante", "codTipoCpe") || "",
  ).trim();
  const serie = String(pick("nroSerie", "numSerie", "serie") || "").trim();
  const numero = String(
    pick("nroFactura", "numComprobante", "numero", "nroDocumento") || "",
  ).trim();

  return {
    id: [tipo, serie, numero, pick("nroRucEmisor", "numRucEmisor", "rucEmisor")].join("|"),
    tipo,
    tipo_label: String(
      pick("desTipoComprobante", "descripcionTipo", "tipoComprobanteDesc") ||
        TIPO_LABELS[tipo] ||
        tipo ||
        "Comprobante",
    ),
    serie,
    numero,
    numero_desc: String(
      pick("nroFacturaDesc", "numeroDesc", "descComprobante") ||
        (serie && numero ? `${serie}-${numero}` : numero),
    ),
    fecha: String(pick("fechaEmisionDesc", "fecEmision", "fechaEmision") || ""),
    ruc_emisor: String(pick("nroRucEmisor", "numRucEmisor", "rucEmisor") || ""),
    emisor: String(
      pick("razonSocialEmisor", "nomRazonSocialEmisor", "desEmisor", "nombreEmisor") || "",
    ),
    ruc_receptor: String(
      pick("nroRucReceptor", "numRucReceptor", "rucReceptor", "nroDocReceptor") || "",
    ),
    receptor: String(
      pick("razonSocialReceptor", "nomRazonSocialReceptor", "desReceptor", "nombreReceptor") || "",
    ),
    total: toNumber(pick("importeTotal", "mtoTotal", "total", "importe", "mtoImporteTotal")),
    moneda: String(pick("codMoneda", "moneda", "tipMoneda") || ""),
    estado: String(pick("desEstado", "estado", "descripcionEstado") || ""),
    raw,
  };
}

class SunatClient {
  constructor(options = {}) {
    this.ruc = String(options.ruc || "").trim();
    this.solUser = String(options.solUser || "").trim();
    this.solPassword = String(options.solPassword || "");
    this.documento = options.documento === "boleta" ? "boleta" : "factura";
    this.sire = Boolean(options.sire);
    this.buzon = Boolean(options.buzon);
    this.menuTokens = {};
    this.buzonFrame = null;
    this.buzonDetailRouteHandler = null;
    this.allowBuzonDetail = false;
    this.lastBuzonRequestAt = 0;
    this.headless = options.headless !== false;
    this.consultaUrl = CONSULTA_URL;
    this.consultaReferer = CONSULTA_REFERER;
    this.statePath =
      options.statePath || path.join(process.cwd(), ".session", `${this.ruc}.json`);
    this.log = options.log || ((message) => process.stderr.write(`${message}\n`));
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  async open() {
    if (!this.ruc || !this.solUser || !this.solPassword) {
      throw new Error("Faltan las credenciales SOL (RUC, usuario y clave).");
    }

    this.browser = await chromium.launch({
      headless: this.headless,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
      ],
    });

    // Por defecto se hace un login limpio en cada consulta. Reutilizar la
    // sesión de una corrida anterior puede dejar cookies inválidas y hacer
    // que el login se salte o falle.
    const reuseSession = process.env.SUNAT_REUSE_SESSION === "true";
    await this.startSession(!reuseSession);
  }

  async startSession(forceLogin = false) {
    if (this.context) {
      await this.context.close().catch(() => undefined);
      this.context = null;
    }

    this.buzonFrame = null;
    this.buzonDetailRouteHandler = null;
    this.allowBuzonDetail = false;
    this.menuTokens = {};

    const useStored = !this.sire && !forceLogin && freshState(this.statePath);
    const contextOptions = {
      locale: "es-PE",
      timezoneId: "America/Lima",
      viewport: { width: 1360, height: 900 },
      acceptDownloads: true,
      userAgent:
        process.env.SUNAT_USER_AGENT ||
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    };

    if (useStored) {
      contextOptions.storageState = this.statePath;
      this.log("Reutilizando sesión SOL guardada...");
    }

    try {
      this.context = await this.browser.newContext(contextOptions);
    } catch (error) {
      this.log(`No se pudo reutilizar la sesión: ${error.message}`);
      delete contextOptions.storageState;
      this.context = await this.browser.newContext(contextOptions);
    }

    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", {
        get: () => undefined,
      });
    });

    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(60000);

    let ready = false;
    if (useStored) {
      try {
        if (this.buzon) {
          await this.openBuzonWithRetry();
        } else {
          await this.openModule(this.page, { navigate: true });
        }
        ready = true;
      } catch (error) {
        this.log(`Sesión guardada inválida: ${error.message}`);
      }
    }

    if (!ready) {
      try {
        await this.login(this.page);
        // Tras el login, SUNAT ya nos deja en el menú. No se debe recargar
        // MenuInternet.htm porque se pierde el estado de la sesión y queda
        // una pantalla "Bienvenidos a SUNAT" en blanco.
        // Para SIRE/Consulta CPE no se abre el módulo de facturas: se trabaja
        // desde el menú para obtener los tokens de cada servicio. El Buzón
        // tampoco abre SEE-SOL: entra al visor de notificaciones.
        if (this.buzon) {
          await this.openBuzonWithRetry();
        } else if (!this.sire) {
          await this.openModule(this.page, { navigate: false });
        }
        await this.saveState();
      } catch (error) {
        // No dejar una sesión guardada que pueda volver a romper el login.
        fs.rmSync(this.statePath, { force: true });
        throw error;
      }
    }
  }

  async relogin() {
    if (this.browser) {
      await this.startSession(true);
    }
  }

  async close() {
    if (this.context) await this.context.close().catch(() => undefined);
    if (this.browser) await this.browser.close().catch(() => undefined);
    this.context = null;
    this.page = null;
    this.browser = null;
    this.buzonFrame = null;
    this.buzonDetailRouteHandler = null;
    this.allowBuzonDetail = false;
  }

  async saveState() {
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      await this.context.storageState({ path: this.statePath });
      fs.chmodSync(this.statePath, 0o600);
    } catch (error) {
      this.log(`No se pudo guardar la sesión: ${error.message}`);
    }
  }

  async openBuzonWithRetry() {
    try {
      await this.openBuzon(this.page);
    } catch (error) {
      if (!/sesión|session|expir|menú|buz[oó]n/i.test(error.message)) throw error;
      this.log(`No se pudo abrir el Buzón (${error.message}); reintentando el login...`);
      await this.login(this.page);
      await this.openBuzon(this.page);
    }
  }

  /**
   * Abre el visor del Buzón SOL sin entrar al detalle de los mensajes.
   * SUNAT marca un mensaje como leído en cuanto se pide su detalle, así que
   * se bloquea `/obtenerDetalleNotiMen` antes de abrir el módulo.
   */
  async openBuzon(page) {
    if (!page) throw new Error("No hay una página de SUNAT disponible.");
    this.buzonFrame = null;

    if (this.buzonDetailRouteHandler) {
      await this.context
        .unroute(BUZON_DETAIL_ROUTE, this.buzonDetailRouteHandler)
        .catch(() => undefined);
    }

    this.buzonDetailRouteHandler = (route) =>
      this.allowBuzonDetail ? route.continue() : route.abort();

    await this.context
      .route(BUZON_DETAIL_ROUTE, this.buzonDetailRouteHandler)
      .catch(() => undefined);

    if (/loginMenuSol/i.test(page.url())) {
      throw new Error("La sesión SOL expiró.");
    }

    const findTarget = () => {
      for (const candidate of this.context.pages()) {
        if (/ol-ti-itvisornoti/i.test(candidate.url())) return candidate.mainFrame();
        for (const frame of candidate.frames()) {
          if (/ol-ti-itvisornoti/i.test(frame.url())) return frame;
        }
      }
      return null;
    };

    const waitForTarget = async (timeoutMs = 35000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const target = findTarget();
        if (target) return target;
        if (/loginMenuSol/i.test(page.url())) throw new Error("La sesión SOL expiró.");
        await sleep(500);
      }
      return null;
    };

    const settle = async (frame) => {
      await frame
        .waitForLoadState("domcontentloaded", { timeout: 15000 })
        .catch(() => undefined);
      await sleep(1500);
    };

    let target = findTarget();
    if (target) {
      await settle(target);
      this.buzonFrame = target;
      this.log(`Buzón SOL abierto: ${target.url()}`);
      return;
    }

    const clickBuzonLink = async () => {
      for (const frame of page.frames()) {
        const link = frame
          .getByRole("link", { name: /buz[oó]n\s*electr[oó]nico/i })
          .or(frame.getByText(/buz[oó]n\s*electr[oó]nico/i))
          .first();

        if ((await link.count()) === 0) continue;

        try {
          await link.click({ timeout: 12000 });
          await page.waitForTimeout(1500);
          return true;
        } catch (error) {
          this.log(`No se pudo abrir el Buzón desde el menú: ${error.message}`);
        }
      }
      return false;
    };

    if (!/e-menu\.sunat\.gob\.pe/i.test(page.url())) {
      await page
        .goto(MENU_URLS[0], { waitUntil: "domcontentloaded", timeout: 60000 })
        .catch((error) => this.log(`No se pudo abrir el menú SUNAT: ${error.message}`));
      await page.waitForTimeout(2500);
    }

    await clickBuzonLink();
    target = await waitForTarget();

    if (!target) {
      this.log("El enlace del Buzón no abrió el visor; probando acceso directo...");
      await page
        .goto(BUZON_MENU_URL, { waitUntil: "domcontentloaded", timeout: 60000 })
        .catch((error) => this.log(`No se pudo abrir el Buzón: ${error.message}`));
      await page.waitForTimeout(2500);
      await clickBuzonLink();
      target = await waitForTarget(20000);
    }

    if (!target) {
      throw new Error(
        "No se pudo abrir el Buzón SOL. Activa \"Mostrar navegador\" y verifica que el usuario tenga acceso al Buzón Electrónico.",
      );
    }

    await settle(target);
    this.buzonFrame = target;
    this.log(`Buzón SOL abierto: ${target.url()}`);
  }

  /**
   * Solicita metadatos al visor del Buzón. Por defecto solo lista: pedir el
   * detalle (`obtenerDetalleBuzon`) es lo que marca el mensaje como leído.
   */
  async buzonFetch(pathname, query = {}, options = {}) {
    if (!this.buzonFrame) throw new Error("El Buzón SOL no está abierto.");

    const url = `${BUZON_BASE}${pathname}?${new URLSearchParams(query).toString()}`;
    const requestHeaders = {
      accept: "application/json",
      "X-Ruc": this.ruc,
      "X-Requested-With": "XMLHttpRequest",
      ...(options.headers || {}),
    };
    let lastError = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      const wait = 1200 - (Date.now() - (this.lastBuzonRequestAt || 0));
      if (wait > 0) await sleep(wait);
      this.lastBuzonRequestAt = Date.now();

      try {
        const result = await this.buzonFrame.evaluate(
          async ({ targetUrl, headers }) => {
            try {
              const response = await fetch(targetUrl, {
                credentials: "include",
                headers,
                signal: AbortSignal.timeout(30000),
              });
              const text = await response.text();
              let data = null;
              try {
                data = JSON.parse(text);
              } catch {
                data = null;
              }
              return { ok: response.ok, status: response.status, data, text: text.slice(0, 300) };
            } catch (error) {
              return { ok: false, status: 0, data: null, text: error.message };
            }
          },
          { targetUrl: url, headers: requestHeaders },
        );

        if (result.ok && result.data !== null) return result.data;

        if (result.status === 401) {
          throw new Error("La sesión SOL expiró.");
        }

        lastError = new Error(
          result.text || `El Buzón SUNAT respondió ${result.status}.`,
        );

        if (result.status === 0 || result.status === 429 || result.status >= 500) {
          await sleep(2000 * (attempt + 1));
          continue;
        }

        break;
      } catch (error) {
        if (/sesión|session|autenticacion|expir/i.test(error.message)) throw error;
        lastError = error;
        await sleep(1500 * (attempt + 1));
      }
    }

    throw new Error(
      lastError?.message || "No se pudo consultar el Buzón SOL.",
    );
  }

  /**
   * Pide el detalle del mensaje. SUNAT lo marca como leído de forma
   * irreversible. Solo se llama si el usuario habilitó "descargar adjuntos".
   */
  async obtenerDetalleBuzon(item) {
    this.allowBuzonDetail = true;
    try {
      return await this.buzonFetch(
        "/obtenerDetalleNotiMen",
        {
          codigoMensaje: String(item.codigo),
          tipoMsj: item.tipo === "mensaje" ? "1" : "2",
        },
        { headers: { "X-Ruc": this.ruc } },
      );
    } finally {
      this.allowBuzonDetail = false;
    }
  }

  async descargarAdjuntoBuzon(item, attachment, detalle) {
    const anexo = detalle?.tieneDocumentosAnexos ? 1 : 0;
    const sistema = detalle?.sistema ?? "";
    const codArchivo = attachment?.codArchivo ?? attachment?.cod_archivo;
    if (codArchivo === undefined || codArchivo === null || codArchivo === "") {
      throw new Error("SUNAT no devolvió el código del adjunto.");
    }

    const pathUrl = `${BUZON_BASE}/bajarArchivo/${encodeURIComponent(
      String(codArchivo),
    )}/${anexo}/${encodeURIComponent(String(sistema))}/${encodeURIComponent(this.ruc)}`;

    let response = await this.context.request.get(pathUrl, {
      headers: {
        "X-Ruc": this.ruc,
        Referer: this.buzonFrame?.url?.() || BUZON_BASE,
      },
      timeout: 120000,
    });

    if (!response.ok()) {
      response = await this.context.request.post(`${BUZON_BASE}/bajarArchivo`, {
        form: {
          cod_arch: String(codArchivo),
          anexo: String(anexo),
          token: this.ruc,
          sistema: String(sistema),
        },
        headers: {
          "X-Ruc": this.ruc,
          Referer: this.buzonFrame?.url?.() || BUZON_BASE,
        },
        timeout: 120000,
      });
    }

    const contentType = String(response.headers()["content-type"] || "").toLowerCase();
    const body = await response.body();

    if (!response.ok() || contentType.includes("text/html")) {
      if (contentType.includes("text/html")) {
        throw new Error("La sesión SOL expiró al descargar el adjunto.");
      }
      throw new Error(`SUNAT respondió ${response.status()} al descargar el adjunto.`);
    }

    if (!body.length) {
      throw new Error("SUNAT devolvió un adjunto vacío.");
    }

    return {
      content: body,
      mime: contentType.split(";")[0] || "application/octet-stream",
      filename: String(attachment.nomArchivo || `adjunto-${codArchivo}`),
    };
  }

  async buzonPage(kind, pageNumber) {
    const data = await this.buzonFetch("/listNotiMenPag", {
      tipoMsj: kind === "mensaje" ? "1" : "2",
      codCarpeta: "00",
      codEtiqueta: "",
      page: String(pageNumber),
      des_asunto: "",
      codMensaje: "",
      tipoOrden: "NADA",
    });

    const nested = data?.data && typeof data.data === "object" ? data.data : null;
    const rows = Array.isArray(data?.rows)
      ? data.rows
      : Array.isArray(nested?.rows)
        ? nested.rows
        : Array.isArray(data?.lista)
          ? data.lista
          : Array.isArray(nested?.lista)
            ? nested.lista
            : Array.isArray(data?.data)
              ? data.data
              : Array.isArray(data)
                ? data
                : [];

    const message = String(
      data?.messageError || data?.mensaje || data?.message || nested?.messageError || "",
    ).trim();
    if (!rows.length && message && /error|no se|sesi[oó]n|expirad|denegad|bloquead/i.test(message)) {
      throw new Error(message);
    }

    const endPage = Number(data?.endPage ?? nested?.endPage);
    return {
      rows,
      endPage: Number.isFinite(endPage) ? endPage : null,
    };
  }

  /**
   * Lista notificaciones y mensajes del Buzón SOL (solo metadatos).
   * tipo: "todos" | "notificaciones" | "mensajes".
   */
  async listarBuzon({ tipo = "todos", maxPages = 20 } = {}) {
    return this.withRetry(async () => {
      if (!this.buzonFrame) throw new Error("El Buzón SOL no está abierto.");

      const kinds =
        tipo === "notificaciones"
          ? ["notificacion"]
          : tipo === "mensajes"
            ? ["mensaje"]
            : ["mensaje", "notificacion"];

      const items = [];
      const seen = new Set();

      for (const kind of kinds) {
        const limite = Math.min(Math.max(Number(maxPages) || 20, 1), 100);
        const antes = items.length;

        for (let pageNumber = 1; pageNumber <= limite; pageNumber++) {
          const { rows } = await this.buzonPage(kind, pageNumber);

          if (!rows.length) break;

          let added = 0;
          for (const row of rows) {
            const item = this.normalizeBuzonRow(row, kind);
            if (!item || seen.has(item.id)) continue;
            seen.add(item.id);
            items.push(item);
            added += 1;
          }

          // SUNAT a veces informa mal `endPage`/`total`. Se sigue paginando
          // hasta que una página no aporte registros nuevos.
          if (pageNumber > 1 && added === 0) break;
          await sleep(1200);
        }

        this.log(`Buzón ${kind}: ${items.length - antes} registro(s).`);
      }

      this.log(`Buzón SOL: ${items.length} mensaje(s)/notificación(es).`);
      return items;
    });
  }

  normalizeBuzonRow(row, kind) {
    if (!row || typeof row !== "object") return null;

    const code = row.codMensaje ?? row.codMensajeNoti ?? row.codigo;
    if (code === undefined || code === null || String(code).trim() === "") return null;

    const clean = (value) =>
      String(value ?? "")
        .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
        .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    const attachments = Number(row.cantidadArchAdj);
    const tipoLabel = kind === "mensaje" ? "Mensaje" : "Notificación";

    return {
      id: `${kind}:${String(code).trim()}`,
      codigo: String(code).trim(),
      tipo: kind,
      tipo_label: tipoLabel,
      asunto: clean(row.desAsunto) || "(sin asunto)",
      fecha_envio: clean(row.fecEnvio),
      fecha_publicacion: clean(row.fecPublica),
      fecha_vigencia: clean(row.fecVigencia),
      urgente: String(row.indUrg ?? "") === "1",
      destacado: String(row.indDesta ?? "") === "1",
      aviso: String(row.indAviso ?? "") === "1",
      estado_codigo: clean(row.indEstado),
      adjuntos: Number.isFinite(attachments) ? attachments : 0,
      carpeta: clean(row.codCarpeta),
      etiqueta: clean(row.codEtiqueta),
    };
  }

  async fillLoginForm(page) {
    // La página trae también los campos del tab DNI ocultos. Esperar al
    // primer input "form input" a secas se queda esperando al DNI invisible.
    try {
      await page
        .locator("form input:visible")
        .first()
        .waitFor({ state: "visible", timeout: 60000 });
    } catch {
      throw new Error(
        "No se cargó el formulario de acceso SOL. Verifica tu conexión con SUNAT.",
      );
    }

    const rucInput = page.locator("#txtRuc");
    if ((await rucInput.count()) > 0) {
      if (!(await rucInput.isVisible())) {
        await page
          .getByRole("button", { name: /^RUC$/i })
          .first()
          .click()
          .catch(() => undefined);
      }

      await rucInput.fill(this.ruc);
      await page.locator("#txtUsuario").fill(this.solUser);
      await page.locator("#txtContrasena").fill(this.solPassword);
    } else {
      const inputs = page.locator("form input:visible");
      if ((await inputs.count()) < 3) {
        throw new Error("No se encontró el formulario de acceso SOL.");
      }
      await inputs.nth(0).fill(this.ruc);
      await inputs.nth(1).fill(this.solUser);
      await inputs.nth(2).fill(this.solPassword);
    }

    const submit = page
      .locator("form button:visible")
      .filter({ hasText: /iniciar sesión|ingresar|acceder/i })
      .first();

    if ((await submit.count()) > 0) {
      await submit.click();
    } else {
      await page.locator('form button[type="submit"]:visible, form button:visible').last().click();
    }
  }

  async login(page) {
    this.log("Iniciando sesión en SUNAT SOL...");
    const context = page.context();
    const pagesBefore = new Set(context.pages());

    const entryUrls = process.env.SUNAT_LOGIN_URL
      ? [process.env.SUNAT_LOGIN_URL]
      : MENU_URLS;

    let loginPageReady = false;

    for (const entryUrl of entryUrls) {
      // Ir al menú de SUNAT deja que el servidor genere el `state` y el
      // `redirect_uri` válidos. Construir esa URL a mano provoca que, tras el
      // login, quede una página en blanco en api-seguridad (code=...).
      this.log(`Abriendo acceso SOL: ${entryUrl}`);
      await page
        .goto(entryUrl, { waitUntil: "domcontentloaded", timeout: 60000 })
        .catch((error) => this.log(`No se pudo abrir ${entryUrl}: ${error.message}`));
      await page.waitForTimeout(1500);

      const hasLoginForm =
        (await page.locator("#txtRuc").isVisible().catch(() => false)) ||
        /loginMenuSol/i.test(page.url());

      if (hasLoginForm) {
        loginPageReady = true;
        break;
      }

      const body = (await page.locator("body").innerText().catch(() => "")) || "";
      if (/Empresas|Comprobantes de pago/i.test(body)) {
        this.log("La sesión SOL ya estaba activa.");
        this.page = page;
        return;
      }
    }

    if (!loginPageReady) {
      throw new Error(
        `No se encontró el formulario de login de SUNAT (URL actual: ${page.url()}).`,
      );
    }

    await this.fillLoginForm(page);

    // El login de SUNAT puede navegar en la misma pestaña o abrir el menú en
    // una pestaña nueva. Se espera hasta 30s a que aparezca e-menu.
    let activePage = null;
    let loginRetried = false;
    const deadline = Date.now() + 30000;

    while (Date.now() < deadline) {
      const pages = [...context.pages()].reverse();
      const menuPage = pages.find((candidate) =>
        /e-menu\.sunat\.gob\.pe/i.test(candidate.url()),
      );

      if (menuPage) {
        activePage = menuPage;
        break;
      }

      const newLoginPage = pages.find(
        (candidate) =>
          !pagesBefore.has(candidate) && /loginMenuSol/i.test(candidate.url()),
      );

      if (newLoginPage && !loginRetried) {
        loginRetried = true;
        this.log("El login se abrió en otra pestaña; completando credenciales...");
        pagesBefore.add(newLoginPage);
        await newLoginPage.waitForLoadState("domcontentloaded").catch(() => undefined);
        await this.fillLoginForm(newLoginPage).catch((error) =>
          this.log(`No se pudo completar el login en la nueva pestaña: ${error.message}`),
        );
        continue;
      }

      await page.waitForTimeout(500);
    }

    if (!activePage) {
      // No se acepta una pestaña vacía ni la pantalla muerta
      // api-seguridad.../?code=...; se prefiere la pestaña original.
      const candidates = [...context.pages()]
        .reverse()
        .filter(
          (candidate) =>
            !/^about:blank$/i.test(candidate.url()) &&
            !/^https:\/\/api-seguridad\.sunat\.gob\.pe\/?\?/i.test(candidate.url()),
        );

      activePage =
        candidates.find((candidate) => !/loginMenuSol/i.test(candidate.url())) || page;
    }

    this.page = activePage;
    this.log(`Pestaña activa tras el login: ${activePage.url()}`);
    await activePage.waitForLoadState("domcontentloaded").catch(() => undefined);
    await activePage
      .waitForURL(/e-menu\.sunat\.gob\.pe/i, { timeout: 90000 })
      .catch(() => undefined);
    await activePage.waitForTimeout(2500);

    const body = (await activePage.locator("body").innerText().catch(() => "")) || "";
    if (/clave\s*(sol)?\s*(incorrect|inválid)|usuario\s*(incorrect|inválid)|bloquead/i.test(body)) {
      throw new Error("SUNAT rechazó las credenciales SOL.");
    }

    if (/loginMenuSol/i.test(activePage.url())) {
      throw new Error(
        "No se pudo iniciar sesión en SUNAT SOL. Revisa el RUC, usuario y clave.",
      );
    }

    this.log(`Sesión SOL iniciada (${activePage.url()}).`);
  }

  async menuLabelVisible(page, labels) {
    const list = Array.isArray(labels) ? labels : [labels];

    for (const label of list) {
      const matches = page.getByText(menuTextRegex(label));
      const count = Math.min(await matches.count().catch(() => 0), 20);
      for (let index = 0; index < count; index++) {
        if (await matches.nth(index).isVisible().catch(() => false)) return true;
      }
    }

    return false;
  }

  async waitForMenuLabel(page, labels, timeoutMs = 4000) {
    const started = Date.now();

    do {
      if (await this.menuLabelVisible(page, labels)) return true;
      await page.waitForTimeout(250);
    } while (Date.now() - started < timeoutMs);

    return false;
  }

  /**
   * El menú de SUNAT no anida las opciones con <ul>: todas las opciones son
   * <li> planos y la jerarquía se declara en data-padre1/data-padre2/data-padre3
   * (más un contenedor nivelNCuerpo_* por cada rama). Cuando la opción existe
   * pero está oculta, se hacen visibles sus padres y la propia opción para que
   * Playwright pueda hacer clic. No se hace clic en los padres porque eso
   * alternaría ramas ya abiertas y las colapsaría.
   */
  async revealMenuTarget(locator) {
    return locator
      .evaluate((element) => {
        const item = element.closest("li");
        if (!item) return false;

        const show = (node) => {
          if (!node) return;
          node.style.display = "block";
        };

        const parents = [
          item.getAttribute("data-padre1"),
          item.getAttribute("data-padre2"),
          item.getAttribute("data-padre3"),
        ].filter(Boolean);

        if (parents.length === 0) {
          // Variante con <li>/<ul> anidados (menú cabina u otras versiones).
          const headers = [];
          let li = item;
          while (li) {
            const parentLi = li.parentElement ? li.parentElement.closest("li") : null;
            if (!parentLi) break;
            const header = parentLi.querySelector(":scope > span, :scope > a");
            if (header) headers.unshift(header);
            li = parentLi;
          }

          for (const header of headers) {
            header.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
            header.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
            header.click();
          }

          return headers.length > 0;
        }

        for (const selector of parents) {
          const parent = document.querySelector(selector);
          if (!parent) continue;

          show(parent);

          const id2 = parent.getAttribute("data-id2");
          const level = (parent.className.match(/nivel(\d)/) || [])[1];
          if (level && id2) {
            show(document.getElementById(`nivel${level}Cuerpo_${id2}`));
          }

          // Menú plano: mostrar los hijos declarados para ese padre.
          document
            .querySelectorAll(
              `li[data-padre1="${selector}"], li[data-padre2="${selector}"], li[data-padre3="${selector}"]`,
            )
            .forEach(show);
        }

        show(item);

        // Asegurar que ningún contenedor ancestro siga oculto (por ejemplo la
        // copia del menú que corresponde a esta opción).
        let ancestor = item.parentElement;
        while (ancestor && ancestor !== document.body) {
          if (getComputedStyle(ancestor).display === "none") show(ancestor);
          ancestor = ancestor.parentElement;
        }

        return true;
      })
      .catch(() => false);
  }

  async clickMenuStep(page, xpath, text) {
    const labels = Array.isArray(text) ? text : [text];

    if (xpath) {
      const byXpath = page.locator(`xpath=${xpath}`).first();
      const exists = (await byXpath.count().catch(() => 0)) > 0;
      const visible = exists && (await byXpath.isVisible().catch(() => false));

      // Si el XPath apunta a una copia oculta del menú, se ignora y se usa la
      // búsqueda por texto, que sí puede expandir la rama padre.
      if (visible) {
        try {
          await byXpath.scrollIntoViewIfNeeded().catch(() => undefined);
          await byXpath.click({ timeout: 8000 });
          await page.waitForTimeout(1000);
          return true;
        } catch (error) {
          this.log(`Click por XPath falló (${labels[0]}): ${error.message}`);
        }
      }
    }

    for (const label of labels) {
      // Segundo intento tras expandir las ramas ancestro que estén cerradas.
      for (let attempt = 0; attempt < 2; attempt++) {
        const matches = page.getByText(menuTextRegex(label));
        const count = Math.min(await matches.count().catch(() => 0), 40);

        // El menú anida los textos en contenedores grandes. Se elige el nodo
        // visible con menos texto para hacer clic en la opción real y no en su
        // padre (o en una copia oculta del menú móvil).
        let target = null;
        let targetLength = Infinity;
        let fallback = null;
        let fallbackLength = Infinity;
        for (let index = 0; index < count; index++) {
          const candidate = matches.nth(index);
          const content = (await candidate.innerText().catch(() => "")).trim();
          if (!content) continue;

          if (content.length < fallbackLength) {
            fallback = candidate;
            fallbackLength = content.length;
          }

          const visible = await candidate.isVisible().catch(() => false);
          if (visible && content.length < targetLength) {
            target = candidate;
            targetLength = content.length;
          }
        }

        if (!target) target = fallback;
        if (!target) break;

        if (!(await target.isVisible().catch(() => false))) {
          const revealed = await this.revealMenuTarget(target);
          if (revealed) {
            this.log(`Menú: opción revelada (${label})`);
            await page.waitForTimeout(600);
            continue;
          }
        }

        try {
          await target.scrollIntoViewIfNeeded().catch(() => undefined);
          await target.click({ timeout: 10000 });
          await page.waitForTimeout(1000);
          return true;
        } catch (error) {
          this.log(`Click por texto falló (${label}): ${error.message}`);
          try {
            await target.click({ timeout: 5000, force: true });
            await page.waitForTimeout(1000);
            return true;
          } catch (forceError) {
            this.log(`Click forzado falló (${label}): ${forceError.message}`);

            // Último recurso: disparar el click en el DOM aunque el nodo siga
            // oculto (por ejemplo si el menú usa manejadores propios).
            const clicked = await target
              .evaluate((element) => {
                element.click();
                return true;
              })
              .catch(() => false);
            if (clicked) {
              await page.waitForTimeout(1500);
              return true;
            }
          }
        }

        break;
      }
    }

    return false;
  }

  captureDebug(page, prefix = "menu") {
    const debugDir = path.join(
      process.env.SUNAT_DATA_DIR || process.cwd(),
      "output",
      "debug",
    );
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");

    try {
      fs.mkdirSync(debugDir, { recursive: true });
      const screenshot = path.join(debugDir, `${prefix}-${stamp}.png`);
      const html = path.join(debugDir, `${prefix}-${stamp}.html`);
      return page
        .screenshot({ path: screenshot, fullPage: true })
        .catch(() => undefined)
        .then(() => page.content().catch(() => ""))
        .then((content) => {
          fs.writeFileSync(html, content, "utf8");
          return ` Debug: ${screenshot}`;
        });
    } catch {
      return Promise.resolve("");
    }
  }

  async waitForConsultaModule(page, menuFrame, timeoutMs = 45000) {
    const started = Date.now();

    while (Date.now() - started < timeoutMs) {
      const iframeCount = await menuFrame
        .locator("iframe#iframeApplication")
        .count()
        .catch(() => 0);
      if (iframeCount > 0) {
        return { locator: menuFrame.frameLocator("iframe#iframeApplication") };
      }

      const moduleFrame = page.frames().find(
        (frame) =>
          frame !== page.mainFrame() &&
          /^https?:\/\/ww1\.sunat\.gob\.pe/i.test(frame.url()) &&
          /consultar|itcons|conscpe/i.test(frame.url()),
      );
      if (moduleFrame) return { frame: moduleFrame };

      const otherPage = page
        .context()
        .pages()
        .find(
          (candidate) =>
            candidate !== page &&
            /^https?:\/\/ww1\.sunat\.gob\.pe/i.test(candidate.url()) &&
            /consultar|itcons|conscpe/i.test(candidate.url()),
        );
      if (otherPage) return { page: otherPage };

      await page.waitForTimeout(500);
    }

    return null;
  }

  async openConsultaDirect(page) {
    this.log("No se detectó el módulo en el menú; se intenta abrir la consulta directamente...");

    try {
      await page.goto(CONSULTA_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
    } catch (error) {
      this.log(`No se pudo abrir la consulta directa: ${error.message}`);
      return false;
    }

    await page.waitForTimeout(3000);

    if (/loginMenuSol/i.test(page.url())) return false;

    const body = (await page.locator("body").innerText().catch(() => "")) || "";
    if (/no se ha enviado correctamente los parametros de autenticacion/i.test(body)) {
      this.log("El módulo directo rechazó la sesión.");
      return false;
    }

    if (/tipoConsulta|Fecha de Inicio|Comprobantes?|Factura|Boleta/i.test(body)) {
      this.consultaUrl = CONSULTA_URL;
      this.consultaReferer = CONSULTA_URL;
      this.log(`Módulo SUNAT directo: ${CONSULTA_URL}`);
      return true;
    }

    return false;
  }

  async openModule(page, { navigate = true } = {}) {
    if (!navigate) {
      await page.waitForTimeout(2000);
      this.log(`Usando la página posterior al login: ${page.url()}`);
    }

    if (/loginMenuSol/i.test(page.url())) {
      throw new Error("La sesión SOL expiró.");
    }

    const waitForMenuFrame = async (timeoutMs = 25000) => {
      const started = Date.now();

      while (Date.now() - started < timeoutMs) {
        for (const frame of page.frames()) {
          const text = (await frame.locator("body").innerText().catch(() => "")) || "";
          if (/Empresas|Comprobantes de pago/i.test(text)) {
            return frame;
          }
        }
        await page.waitForTimeout(500);
      }

      return null;
    };

    const prepareMenu = async () => {
      // Algunas cuentas aterrizan en una pantalla "Bienvenidos a SUNAT" con un
      // enlace para entrar al menú. Se intenta abrir antes de buscar opciones.
      const welcomeBody = (await page.locator("body").innerText().catch(() => "")) || "";
      if (/bienvenid/i.test(welcomeBody)) {
        const enter = page
          .getByRole("link", { name: /ingresar|continuar|menú|menu/i })
          .or(page.getByRole("button", { name: /ingresar|continuar|menú|menu/i }))
          .first();
        if ((await enter.count()) > 0) {
          await enter.click().catch(() => undefined);
          await page.waitForTimeout(2500);
        }
      }

      return waitForMenuFrame();
    };

    // Si el login ya dejó el menú abierto, se usa tal cual. Si no, se prueban
    // el menú clásico y el nuevo menú "cabina" de SUNAT.
    let menuFrame = navigate ? null : await prepareMenu();

    for (const menuUrl of MENU_URLS) {
      if (menuFrame) break;

      this.log(`Abriendo menú SUNAT: ${menuUrl}`);
      await page
        .goto(menuUrl, { waitUntil: "domcontentloaded", timeout: 60000 })
        .catch((error) => this.log(`No se pudo abrir ${menuUrl}: ${error.message}`));
      await page.waitForTimeout(2000);

      if (/loginMenuSol/i.test(page.url())) {
        this.log("El menú redirigió al login; se detiene el intento.");
        break;
      }

      menuFrame = await prepareMenu();
    }

    if (!menuFrame) {
      const body = (await page.locator("body").innerText().catch(() => "")) || "";
      const debugInfo = await this.captureDebug(page, "menu");

      this.log(`Frames: ${page.frames().map((frame) => frame.url()).join(" | ")}`);

      throw new Error(
        `No se cargó el menú de SUNAT (URL: ${page.url()}). ` +
          `Activa "Mostrar navegador" para ver la pantalla.${debugInfo} Contenido: ${body
            .replace(/\s+/g, " ")
            .slice(0, 200)}`,
      );
    }

    const step = async (xpath, labels) => {
      const ok = await this.clickMenuStep(menuFrame, xpath, labels);
      const label = Array.isArray(labels) ? labels[0] : labels;
      this.log(`Menú ${ok ? "OK" : "sin coincidencia"}: ${label}`);
      return ok;
    };

    const isVisibleLabel = (labels) => this.menuLabelVisible(menuFrame, labels);

    const comprobantesLabels = ["Comprobantes de pago", "Comprobante de Pago"];
    const seeLabels = ["SEE - SOL", "SEE-SOL", "SEE SOL", "Emisión Electrónica SOL"];
    const comprobantesXpath =
      "/html/body/div[5]/div[2]/div[2]/div//span[contains(normalize-space(.), 'Comprobantes de pago')]";

    // Atajo: el menú de SUNAT expone una función que ejecuta directamente la
    // opción de nivel 4 (la que abre el módulo) usando su data-id, sin depender
    // de que las ramas estén visibles o expandidas.
    const ejecutarDirecto = async (labels) => {
      for (const label of labels) {
        const matches = menuFrame.getByText(menuTextRegex(label));
        const count = Math.min(await matches.count().catch(() => 0), 40);

        for (let index = 0; index < count; index++) {
          const node = matches.nth(index);
          const code = await node
            .evaluate((element) => {
              const li = element.closest("li");
              return li && li.classList.contains("nivel4")
                ? li.getAttribute("data-id")
                : null;
            })
            .catch(() => null);
          if (!code) continue;

          const executed = await menuFrame
            .evaluate((id) => {
              try {
                const $ = window.jQuery || window.$;
                const li = document.querySelector(`li.nivel4[data-id="${id}"]`);
                if (!$ || !li) return false;

                if (typeof window.clickEnNivel4 === "function") {
                  window.clickEnNivel4($(li));
                  return true;
                }

                if (typeof window.logoutAndLoad === "function") {
                  window.logoutAndLoad("MenuInternet.htm?action=execute&code=" + id);
                  return true;
                }
              } catch {
                return false;
              }

              return false;
            }, code)
            .catch(() => false);

          if (executed) {
            this.log(`Menú ejecutado directamente: ${label}`);
            return true;
          }
        }
      }

      return false;
    };

    const abrirConsultar = async ({ itemLabels, itemXpath, consultarLabels, consultarXpath }) => {
      if (await this.waitForMenuLabel(menuFrame, consultarLabels, 2500)) {
        await step(consultarXpath, consultarLabels);
        return;
      }

      if (!(await this.menuLabelVisible(menuFrame, itemLabels))) {
        if (!(await this.menuLabelVisible(menuFrame, seeLabels))) {
          await step(comprobantesXpath, comprobantesLabels);
          await this.waitForMenuLabel(menuFrame, seeLabels, 4000);
        }

        // clickMenuStep hace visible la opción aunque su rama esté cerrada.
        await step(itemXpath, itemLabels);
      }

      await this.waitForMenuLabel(menuFrame, consultarLabels, 5000);

      if (await this.menuLabelVisible(menuFrame, consultarLabels)) {
        await step(consultarXpath, consultarLabels);
        return;
      }

      await ejecutarDirecto(consultarLabels);
    };

    // Si el menú ya viene expandido no se vuelve a hacer clic en "Empresas":
    // hacerlo colapsaría la rama y ocultaría las opciones de Comprobantes.
    if (!(await isVisibleLabel(comprobantesLabels))) {
      await step(
        "/html/body/div[5]/div[2]/div[1]/div/div[contains(normalize-space(.), 'Empresas')]",
        ["Empresas"],
      );
    }

    if (this.documento === "boleta") {
      await abrirConsultar({
        itemLabels: [
          "Boleta de Venta Electrónica",
          "Boletas de Venta Electrónicas",
          "Boleta de Venta",
        ],
        itemXpath: null,
        consultarLabels: [
          "Consultar Boleta de Venta y Nota",
          "Consultar Boleta de Venta",
          "Consultar Boleta",
          "Consulta de Boletas",
        ],
        consultarXpath: null,
      });
    } else {
      await abrirConsultar({
        itemLabels: ["Factura Electrónica", "Facturas Electrónicas", "Factura Electronica"],
        itemXpath:
          "/html/body/div[5]/div[2]/div[2]/div/div[1]/div/div/ul/li[12]/li[10]/li/span[contains(normalize-space(.), 'Factura Electrónica')]",
        consultarLabels: [
          "Consultar Factura y Nota",
          "Consultar Factura, Boleta y Notas",
          "Consultar Factura",
          "Consulta de Facturas",
          "Consultar Comprobantes",
        ],
        consultarXpath:
          "/html/body/div[5]/div[2]/div[2]/div/div[1]/div/div/ul/li[12]/li[10]/li[4]/li/span[contains(normalize-space(.), 'Consultar Factura y Nota')]",
      });
    }

    const opened = await this.waitForConsultaModule(page, menuFrame);

    if (opened?.page) {
      const url = new URL(opened.page.url());
      this.consultaUrl = `${url.origin}${url.pathname}`;
      this.consultaReferer = this.consultaUrl;
      this.log(`Módulo SUNAT: ${this.consultaUrl}`);
      return;
    }

    if (opened?.frame) {
      const url = new URL(opened.frame.url());
      this.consultaUrl = `${url.origin}${url.pathname}`;
      this.consultaReferer = this.consultaUrl;
      this.log(`Módulo SUNAT: ${this.consultaUrl}`);
      return;
    }

    if (opened?.locator) {
      await opened.locator
        .locator("body")
        .waitFor({ state: "visible", timeout: 40000 });
      await page.waitForTimeout(2500);

      const body = (await opened.locator.locator("body").innerText().catch(() => "")) || "";
      if (/no se ha enviado correctamente los parametros de autenticacion/i.test(body)) {
        throw new Error("SUNAT no habilitó la sesión del módulo de consulta.");
      }

      await this.captureModuleUrl(page);
      return;
    }

    const debugInfo = await this.captureDebug(page, "consulta");
    if (await this.openConsultaDirect(page)) return;

    this.log(`Frames: ${page.frames().map((frame) => frame.url()).join(" | ")}`);

    throw new Error(
      "SUNAT no abrió el módulo de consulta. Activa \"Mostrar navegador\" para ver el menú " +
        `y verifica que tu usuario tenga acceso a esa opción.${debugInfo}`,
    );
  }

  /**
   * El módulo de facturas y el de boletas usan URLs distintas. En lugar de
   * adivinar el endpoint de boletas, se toma la URL real del iframe que abrió
   * el menú de SUNAT (la sesión ya está autenticada).
   */
  async captureModuleUrl(page) {
    for (let attempt = 0; attempt < 24; attempt++) {
      const frames = page
        .frames()
        .filter(
          (frame) =>
            frame !== page.mainFrame() &&
            /^https?:\/\/ww1\.sunat\.gob\.pe/i.test(frame.url()),
        );

      const moduleFrame =
        frames.find((frame) => /consultar|itcons/i.test(frame.url())) || frames[0];

      if (moduleFrame) {
        try {
          const url = new URL(moduleFrame.url());
          this.consultaUrl = `${url.origin}${url.pathname}`;
          this.consultaReferer = this.consultaUrl;
          this.log(`Módulo SUNAT: ${this.consultaUrl}`);
          return;
        } catch {
          // La URL del iframe aún no es válida; se reintenta.
        }
      }

      await page.waitForTimeout(500);
    }

    this.log(`No se detectó la URL del módulo; se usa ${this.consultaUrl}`);
  }

  jsonHeaders(token) {
    return {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
  }

  consultacpeHeaders(token) {
    return {
      Authorization: `Bearer ${token}`,
      Accept: "application/json, text/plain, */*",
      Origin: "https://e-factura.sunat.gob.pe",
      Referer: "https://e-factura.sunat.gob.pe/",
    };
  }

  async menuToken({ code, description, parent, match }) {
    const page = this.page;
    if (!page) throw new Error("No hay una página de SUNAT disponible.");

    const atMenu = async () => {
      if (/e-menu\.sunat\.gob\.pe/i.test(page.url())) return true;
      await page
        .goto(MENU_URLS[0], { waitUntil: "domcontentloaded", timeout: 60000 })
        .catch(() => undefined);
      await page.waitForTimeout(2500);
      return /e-menu\.sunat\.gob\.pe/i.test(page.url());
    };

    if (!(await atMenu())) throw new Error("La sesión SOL expiró.");

    const empresas = page
      .locator(
        "xpath=/html/body/div[5]/div[2]/div[1]/div/div[contains(normalize-space(.), 'Empresas')]",
      )
      .first();
    if ((await empresas.count()) > 0) {
      await empresas.click().catch(() => undefined);
      await page.waitForTimeout(1200);
    }

    let hasEjecuta = await page
      .evaluate(() => typeof window.ejecuta === "function")
      .catch(() => false);

    if (!hasEjecuta) {
      await page
        .goto(MENU_URLS[0], { waitUntil: "domcontentloaded", timeout: 60000 })
        .catch(() => undefined);
      await page.waitForTimeout(3000);
      hasEjecuta = await page
        .evaluate(() => typeof window.ejecuta === "function")
        .catch(() => false);
    }

    if (!hasEjecuta) throw new Error("No se cargó el menú de SUNAT.");

    await page.evaluate(
      ({ code, description, parent }) => {
        window.ejecuta(
          `MenuInternet.htm?action=iconExecute&code=${code}`,
          false,
          description,
          parent,
          code,
        );
      },
      { code, description, parent },
    );

    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      for (const frame of page.frames()) {
        const url = frame.url();
        if (!url.includes("token=") || !url.includes(match)) continue;
        const tokenMatch = url.match(/[?&]token=([^&]+)/);
        if (tokenMatch) return decodeURIComponent(tokenMatch[1]);
      }

      if (/loginMenuSol/i.test(page.url())) throw new Error("La sesión SOL expiró.");
      await page.waitForTimeout(500);
    }

    throw new Error(`No se pudo obtener el token de SUNAT (${description}).`);
  }

  async consultacpeToken() {
    if (this.menuTokens.consultacpe) return this.menuTokens.consultacpe;

    const token = await this.menuToken({
      code: "11.38.1.1.1",
      description: "Nueva Consulta de comprobantes de pago",
      parent: "#nivel1_11",
      match: "consultacpe",
    });

    this.menuTokens.consultacpe = token;
    return token;
  }

  sireDocType(tipo) {
    const code = String(tipo);
    if (code === "14") return "07";
    if (code === "16") return "08";
    return this.documento === "boleta" ? "03" : "01";
  }

  async consultarSire({ desde, hasta, tipo }) {
    const [, mm, yyyy] = String(desde).split("/");
    if (!mm || !yyyy) throw new Error("Fecha desde inválida para SIRE.");

    const periodo = `${yyyy}${mm}`;
    const docType = this.sireDocType(tipo);
    const fechaIni = `${yyyy}-${mm}-01`;
    const lastDay = new Date(Number(yyyy), Number(mm), 0).getDate();
    const fechaFin = `${yyyy}-${mm}-${String(lastDay).padStart(2, "0")}`;

    this.log(
      `Consultando SIRE RCE (${tipoLabel(tipo, this.documento)}, periodo ${periodo})...`,
    );

    const token = await this.menuToken({
      code: "60.2.2.1.1",
      description: "Gestion de Compras",
      parent: "#nivel1_60",
      match: "gestionlibrocompras",
    });

    const text = await this.descargarPropuestaSire({
      token,
      periodo,
      fechaIni,
      fechaFin,
      docType,
    });

    const invoices = this.parseSireTxt(text, docType);
    this.log(`SIRE devolvió ${invoices.length} comprobante(s) para ${periodo}.`);
    return invoices;
  }

  async descargarPropuestaSire({ token, periodo, fechaIni, fechaFin, docType }) {
    const headers = this.jsonHeaders(token);
    const exportUrl = `${SIRE_API}/rce/propuesta/web/propuesta/${periodo}/exportacioncomprobantepropuesta`;

    const exportRes = await this.context.request.get(exportUrl, {
      params: {
        codTipoArchivo: "0",
        codOrigenEnvio: "2",
        fecEmisionIni: fechaIni,
        fecEmisionFin: fechaFin,
        codTipoCDP: docType,
      },
      headers,
      timeout: 120000,
    });

    const exportText = await exportRes.text();
    if (!exportRes.ok()) {
      throw new Error(
        `SIRE no pudo exportar la propuesta (${exportRes.status()}): ${exportText
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 200)}`,
      );
    }

    let numTicket = "";
    try {
      numTicket = JSON.parse(exportText).numTicket;
    } catch {
      // Se informa abajo con el texto original.
    }

    if (!numTicket) {
      throw new Error(`SIRE no devolvió un ticket de descarga. ${exportText.slice(0, 200)}`);
    }

    let reg = null;
    let file = null;

    for (let attempt = 0; attempt < 40; attempt++) {
      await sleep(2000);

      const statusRes = await this.context.request.get(
        `${SIRE_API}/rvierce/gestionprocesosmasivos/web/masivo/consultaestadotickets`,
        {
          params: {
            perIni: periodo,
            perFin: periodo,
            page: "1",
            perPage: "20",
            numTicket,
          },
          headers,
          timeout: 120000,
        },
      );

      const status = await statusRes.json().catch(() => null);
      reg = status && Array.isArray(status.registros) ? status.registros[0] : null;

      if (reg && Array.isArray(reg.archivoReporte) && reg.archivoReporte.length > 0) {
        file = reg.archivoReporte[0];
        break;
      }

      if (reg && /error|fall/i.test(String(reg.desEstadoProceso || ""))) {
        throw new Error(`SIRE no pudo generar la propuesta: ${reg.desEstadoProceso}`);
      }
    }

    if (!file) {
      throw new Error("SIRE no generó la propuesta a tiempo. Intenta nuevamente.");
    }

    const downloadRes = await this.context.request.get(
      `${SIRE_API}/rvierce/gestionprocesosmasivos/web/masivo/archivoreporte`,
      {
        params: {
          nomArchivoReporte: file.nomArchivoReporte,
          codTipoArchivoReporte:
            file.codTipoAchivoReporte || file.codTipoArchivoReporte || "null",
          codLibro: "080000",
          perTributario: reg.perTributario || periodo,
          codProceso: reg.codProceso,
          numTicket: reg.numTicket || numTicket,
        },
        headers,
        timeout: 120000,
      },
    );

    const body = await downloadRes.body();
    if (!downloadRes.ok() || body.subarray(0, 2).toString("latin1") !== "PK") {
      throw new Error(
        `SIRE no devolvió la propuesta (${downloadRes.status()}). ${body
          .toString("utf8")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 200)}`,
      );
    }

    const zip = new AdmZip(body);
    const entry =
      zip.getEntries().find((item) => /\.txt$/i.test(item.entryName)) ||
      zip.getEntries()[0];

    if (!entry) throw new Error("El ZIP de SIRE no contiene la propuesta.");

    return entry.getData().toString("utf8");
  }

  parseSireTxt(text, docType) {
    const clean = String(text || "").replace(/^\uFEFF/, "");
    const lines = clean.split(/\r?\n/).filter((line) => line.trim() !== "");
    if (lines.length < 2) return [];

    const headers = lines[0].split("|").map((header) => header.trim());
    const invoices = [];

    for (const line of lines.slice(1)) {
      const cols = line.split("|");
      const row = {};
      headers.forEach((header, index) => {
        row[header] = cols[index] ?? "";
      });

      const rowType = sireValue(row, "Tipo CP/Doc.", "Tipo CP/Doc");
      if (docType && rowType && rowType !== docType) continue;

      const rucEmisor = sireValue(row, "Nro Doc Identidad");
      const serie = sireValue(row, "Serie del CDP");
      let numero = sireValue(
        row,
        "Nro CP o Doc. Nro Inicial (Rango)",
        "Nro CP o Doc. Nro Inicial",
      );

      if (!rucEmisor || !serie || !numero) continue;
      if (/^\d+$/.test(numero)) numero = String(Number(numero));

      const tipo = rowType || docType;
      const estadoRaw = sireValue(row, "Est. Comp.");
      const estado =
        estadoRaw === "1"
          ? "Aceptado"
          : estadoRaw === "0"
            ? "No aceptado"
            : estadoRaw || "Aceptado";

      invoices.push({
        id: `${tipo}|${serie}|${numero}|${rucEmisor}`,
        tipo,
        tipo_label: TIPO_LABELS[tipo] || tipo || "Comprobante",
        serie,
        numero,
        numero_desc: `${serie} - ${numero}`,
        fecha: sireValue(row, "Fecha de emisión", "Fecha de emision"),
        ruc_emisor: rucEmisor,
        emisor: sireValue(
          row,
          "Apellidos Nombres/ Razón Social",
          "Apellidos Nombres/ Razon Social",
        ),
        ruc_receptor: sireValue(row, "RUC") || this.ruc,
        receptor: sireValue(
          row,
          "Apellidos y Nombres o Razón social",
          "Apellidos y Nombres o Razon social",
        ),
        total: toSireNumber(sireValue(row, "Total CP")),
        moneda: sireValue(row, "Moneda"),
        estado,
        sire: true,
        raw: row,
      });
    }

    return invoices;
  }

  async descargarConsultacpe(invoice, suffix) {
    if (!invoice.ruc_emisor || !invoice.tipo || !invoice.serie || !invoice.numero) {
      throw new Error("Faltan datos del comprobante para consultarlo en SUNAT.");
    }

    let token = await this.consultacpeToken();
    const numbers = [String(invoice.numero)];

    if (/^\d+$/.test(String(invoice.numero))) {
      const normalized = String(Number(invoice.numero));
      if (normalized !== String(invoice.numero)) numbers.push(normalized);
    }

    let lastError = null;

    for (const numero of numbers) {
      const url = `${CONSULTACPE_API}/${invoice.ruc_emisor}-${invoice.tipo}-${invoice.serie}-${numero}-2${suffix}`;

      for (let attempt = 0; attempt < 6; attempt++) {
        // SUNAT responde lento y devuelve 500 si se hacen muchas llamadas
        // seguidas. Este pequeño desfase evita que las descargas concurrentes
        // salgan exactamente al mismo tiempo.
        await sleep(500 + Math.floor(Math.random() * 1200));

        const response = await this.context.request.get(url, {
          headers: this.consultacpeHeaders(token),
          timeout: 120000,
        });

        if (response.ok()) {
          const data = await response.json().catch(() => null);
          if (!data || !data.valArchivo) {
            throw new Error("SUNAT no devolvió el archivo del comprobante.");
          }
          return Buffer.from(data.valArchivo, "base64");
        }

        const body = await response.text();
        const message = body
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 300);

        if (response.status() === 401 && attempt === 0) {
          this.menuTokens.consultacpe = null;
          token = await this.consultacpeToken();
          continue;
        }

        lastError = new Error(
          message || `SUNAT respondió ${response.status()} al descargar el comprobante.`,
        );

        if (response.status() === 404 || response.status() === 400) break;

        if (response.status() >= 500 || response.status() === 429) {
          const wait = [5000, 10000, 20000, 30000, 45000, 60000][attempt] || 60000;
          this.log(
            `SUNAT respondió ${response.status()}; reintentando en ${Math.round(wait / 1000)}s...`,
          );
          await sleep(wait + Math.floor(Math.random() * 2000));
          continue;
        }

        break;
      }
    }

    throw lastError || new Error("No se pudo descargar el comprobante.");
  }

  async descargarSire(invoice, formato = "xml") {
    return this.withRetry(async () => {
      if (formato === "pdf") {
        const zip = new AdmZip(await this.descargarConsultacpe(invoice, "/01"));
        const entry = zip.getEntries().find((item) => /\.pdf$/i.test(item.entryName));
        if (!entry) throw new Error("SUNAT no devolvió el PDF del comprobante.");
        return { formato, content: entry.getData(), mime: "application/pdf" };
      }

      if (formato === "cdr") {
        const zip = new AdmZip(await this.descargarConsultacpe(invoice, "/03"));
        const entry = zip
          .getEntries()
          .find((item) => /^R-.*\.xml$/i.test(path.basename(item.entryName)));
        if (!entry) throw new Error("SUNAT no devolvió el CDR del comprobante.");
        return {
          formato,
          content: entry.getData(),
          mime: "application/xml",
          filename: path.basename(entry.entryName),
        };
      }

      const zip = new AdmZip(await this.descargarConsultacpe(invoice, "/02"));
      const entries = zip.getEntries().filter((item) => /\.xml$/i.test(item.entryName));
      const cdrEntry = entries.find((item) => /^R-/i.test(path.basename(item.entryName)));
      const xmlEntry = entries.find((item) => !/^R-/i.test(path.basename(item.entryName)));

      if (!xmlEntry) throw new Error("El ZIP no contiene el XML del comprobante.");

      return {
        formato: "xml",
        content: xmlEntry.getData(),
        mime: "application/xml",
        filename: path.basename(xmlEntry.entryName),
        cdr: cdrEntry ? cdrEntry.getData().toString("utf8") : null,
        cdrName: cdrEntry ? path.basename(cdrEntry.entryName) : null,
      };
    });
  }

  async withRetry(operation) {
    try {
      return await operation();
    } catch (error) {
      if (!/sesión|session|autenticacion|expir/i.test(error.message)) throw error;
      this.log("La sesión expiró; iniciando sesión nuevamente...");
      await this.relogin();
      return operation();
    }
  }

  async consultar({ desde, hasta, tipo = 10 }) {
    return this.withRetry(async () => {
      if (this.sire) return this.consultarSire({ desde, hasta, tipo });

      this.log(`Consultando SUNAT (${this.documento}, tipo ${tipo}: ${tipoLabel(tipo, this.documento)})...`);

      const response = await this.context.request.get(this.consultaUrl, {
        params: {
          action: "realizarConsulta",
          buscarPor: "porPer",
          // El formulario de SUNAT envía estado=0 por defecto.
          estado: "0",
          fec_desde: desde,
          fec_hasta: hasta,
          tipoConsulta: String(tipo),
          // El formulario de SUNAT siempre envía el campo "RUC Emisor" (vacío
          // si no se filtra). En "Facturas recibidas" el módulo lo lee aunque
          // se consulte por periodo; si el parámetro no llega, responde con
          // codeError 1.
          ruc: "",
        },
        timeout: 90000,
        headers: {
          Accept: "text/html,application/xhtml+xml",
          Referer: this.consultaReferer,
        },
      });

      const html = await response.text();
      return this.parseConsultaHtml(html).map(normalizeInvoice);
    });
  }

  parseConsultaHtml(html) {
    if (/loginMenuSol|AutenticaMenuInternet|type=["']password["']/i.test(html)) {
      throw new Error("La sesión SOL expiró.");
    }

    if (/no se ha enviado correctamente los parametros de autenticacion/i.test(html)) {
      throw new Error("SUNAT no habilitó la sesión del módulo de consulta.");
    }

    const match = html.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/i);
    if (!match) {
      const message = html
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 300);
      throw new Error(`SUNAT no devolvió el listado esperado. ${message}`);
    }

    const outer = JSON.parse(decodeEntities(match[1]));
    // SUNAT entrega el detalle del error en `messageError`; `message`/`msg` se
    // mantienen como respaldo por compatibilidad.
    const message = String(
      outer.messageError || outer.message || outer.msg || "",
    ).trim();
    let data = outer.data;
    if (typeof data === "string") {
      try {
        data = data.trim() ? JSON.parse(data) : null;
      } catch {
        data = null;
      }
    }

    if (Number(outer.codeError) !== 0) {
      if (SIN_RESULTADOS_RE.test(message) || (Array.isArray(data) && data.length === 0)) {
        return [];
      }

      throw new Error(
        message || `SUNAT devolvió el código ${outer.codeError}.`,
      );
    }

    if (Array.isArray(data)) return data;

    if (data && typeof data === "object") {
      for (const key of ["lista", "list", "comprobantes", "registros", "data"]) {
        if (Array.isArray(data[key])) return data[key];
      }
      const firstArray = Object.values(data).find(Array.isArray);
      if (firstArray) return firstArray;
      return [data];
    }

    return [];
  }

  invoiceForm(invoice, action) {
    return {
      action,
      ruc: String(invoice.ruc_emisor || "").trim(),
      tipo: String(invoice.tipo || "").trim(),
      serie: String(invoice.serie || "").trim(),
      numero: String(invoice.numero || "").trim(),
    };
  }

  async downloadZip(invoice) {
    return this.withRetry(async () => {
      const response = await this.context.request.post(this.consultaUrl, {
        form: this.invoiceForm(invoice, "descargarFactura"),
        timeout: 120000,
        headers: { Referer: this.consultaReferer },
      });

      const contentType = (response.headers()["content-type"] || "").toLowerCase();
      const body = await response.body();

      if (!response.ok() || contentType.includes("text/html")) {
        const message = body
          .toString("utf8")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 300);
        throw new Error(`No se pudo descargar el XML. ${message || `HTTP ${response.status()}`}`);
      }

      if (!body.length || body.subarray(0, 2).toString("latin1") !== "PK") {
        throw new Error("SUNAT devolvió un archivo inválido (no es un ZIP).");
      }

      return body;
    });
  }

  extractFromZip(buffer) {
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries();
    const xmlEntries = entries.filter(
      (entry) => /\.xml$/i.test(entry.entryName) && !entry.isDirectory,
    );

    if (!xmlEntries.length) {
      throw new Error("El ZIP descargado no contiene archivos XML.");
    }

    const isCdr = (entry) =>
      /^R-/i.test(path.basename(entry.entryName)) ||
      /applicationresponse/i.test(entry.getData().toString("utf8").slice(0, 500));

    const invoiceEntry = xmlEntries.find((entry) => !isCdr(entry));
    const cdrEntry = xmlEntries.find((entry) => isCdr(entry));

    if (!invoiceEntry) {
      throw new Error("El ZIP no contiene el XML del comprobante.");
    }

    return {
      xml: invoiceEntry.getData().toString("utf8"),
      xmlName: path.basename(invoiceEntry.entryName),
      cdr: cdrEntry ? cdrEntry.getData().toString("utf8") : null,
      cdrName: cdrEntry ? path.basename(cdrEntry.entryName) : null,
    };
  }

  async downloadPdf(invoice) {
    return this.withRetry(async () => {
      const response = await this.context.request.post(this.consultaUrl, {
        form: this.invoiceForm(invoice, "descargarComprobanteEnPdf"),
        timeout: 120000,
        headers: { Referer: this.consultaReferer },
      });

      const contentType = (response.headers()["content-type"] || "").toLowerCase();
      const body = await response.body();

      if (!response.ok() || contentType.includes("text/html")) {
        const message = body
          .toString("utf8")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 300);
        throw new Error(`No se pudo descargar el PDF. ${message || `HTTP ${response.status()}`}`);
      }

      if (!body.length || body.subarray(0, 4).toString("latin1") !== "%PDF") {
        throw new Error("SUNAT devolvió un archivo inválido (no es un PDF).");
      }

      return body;
    });
  }

  async descargar(invoice, formato = "xml") {
    if (invoice.sire) return this.descargarSire(invoice, formato);

    if (formato === "pdf") {
      return { formato, content: await this.downloadPdf(invoice), mime: "application/pdf" };
    }

    const zip = await this.downloadZip(invoice);
    const files = this.extractFromZip(zip);

    if (formato === "cdr") {
      if (!files.cdr) throw new Error("SUNAT no devolvió el CDR de este comprobante.");
      return {
        formato,
        content: Buffer.from(files.cdr, "utf8"),
        mime: "application/xml",
        filename: files.cdrName,
      };
    }

    return {
      formato: "xml",
      content: Buffer.from(files.xml, "utf8"),
      mime: "application/xml",
      filename: files.xmlName,
      cdr: files.cdr,
      cdrName: files.cdrName,
    };
  }

  async detalle(invoice) {
    const zip = await this.downloadZip(invoice);
    const files = this.extractFromZip(zip);
    return {
      detail: parseUbl(files.xml),
      cdr: files.cdr,
      cdrName: files.cdrName,
    };
  }
}

module.exports = {
  SunatClient,
  TIPOS,
  TIPO_LABELS,
  DOCUMENTOS,
  TIPOS_RECIBIDOS,
  tipoLabel,
  normalizeInvoice,
};
