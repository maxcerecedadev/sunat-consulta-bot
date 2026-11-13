"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const AdmZip = require("adm-zip");
const { chromium } = require("playwright");
const { parseUbl } = require("../ubl");
const { TIPOS, TIPO_LABELS, DOCUMENTOS, tipoLabel } = require("../cpe-types");
const {
  tipoCpeVariants,
  filtrosCpe,
  buildCpeComprobanteId,
  buildCpeDescargaUrl,
  esBoleta,
} = require("../cpe-ids");
const {
  parseSireComprasTxt,
  parseSireVentasTxt,
} = require("../sire-parser");
const {
  CONSULTA_URL,
  CONSULTA_REFERER,
  MENU_URLS,
  STATE_TTL_MS,
  SIRE_API,
  CONSULTACPE_API,
  CONTROLCPE_API,
  BUZON_BASE,
  BUZON_MENU_URL,
  BUZON_DETAIL_ROUTE,
  TIPOS_RECIBIDOS,
  sleep,
  SIN_RESULTADOS_RE,
  decodeEntities,
  toNumber,
  sunatToIsoDate,
  isMissingSireFile,
  isoToSunatDate,
  freshState,
  menuTextRegex,
  normalizeInvoice,
} = require("./common");

module.exports = {
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
   */,

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
   */,

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
   */,

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
  },

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
  },

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
   */,

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
  },

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
};
