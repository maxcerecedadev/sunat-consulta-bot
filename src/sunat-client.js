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

    const useStored = !forceLogin && freshState(this.statePath);
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
        await this.openModule(this.page, { navigate: true });
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
        await this.openModule(this.page, { navigate: false });
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

  async clickMenuStep(page, xpath, text) {
    if (xpath) {
      const byXpath = page.locator(`xpath=${xpath}`).first();
      if ((await byXpath.count()) > 0) {
        try {
          await byXpath.click({ timeout: 15000 });
          await page.waitForTimeout(900);
          return true;
        } catch (error) {
          this.log(`Click por XPath falló (${text}): ${error.message}`);
        }
      }
    }

    const byText = page.getByText(new RegExp(text, "i")).first();
    if ((await byText.count()) > 0) {
      try {
        await byText.click({ timeout: 10000 });
        await page.waitForTimeout(800);
        return true;
      } catch (error) {
        this.log(`Click por texto falló (${text}): ${error.message}`);
      }
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
      const debugDir = path.join(
        process.env.SUNAT_DATA_DIR || process.cwd(),
        "output",
        "debug",
      );
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      let debugInfo = "";

      try {
        fs.mkdirSync(debugDir, { recursive: true });
        const screenshot = path.join(debugDir, `menu-${stamp}.png`);
        const html = path.join(debugDir, `menu-${stamp}.html`);
        await page.screenshot({ path: screenshot, fullPage: true }).catch(() => undefined);
        fs.writeFileSync(html, await page.content().catch(() => ""), "utf8");
        debugInfo = ` Debug: ${screenshot}`;
      } catch {
        // El diagnóstico es opcional.
      }

      this.log(`Frames: ${page.frames().map((frame) => frame.url()).join(" | ")}`);

      throw new Error(
        `No se cargó el menú de SUNAT (URL: ${page.url()}). ` +
          `Activa "Mostrar navegador" para ver la pantalla.${debugInfo} Contenido: ${body
            .replace(/\s+/g, " ")
            .slice(0, 200)}`,
      );
    }

    await this.clickMenuStep(
      menuFrame,
      "/html/body/div[5]/div[2]/div[1]/div/div[contains(normalize-space(.), 'Empresas')]",
      "Empresas",
    );
    await this.clickMenuStep(
      menuFrame,
      "/html/body/div[5]/div[2]/div[2]/div//span[contains(normalize-space(.), 'Comprobantes de pago')]",
      "Comprobantes de pago",
    );
    await this.clickMenuStep(
      menuFrame,
      "/html/body/div[5]/div[2]/div[2]/div/div[1]/div/div/ul/li[12]/li/span[contains(normalize-space(.), 'SEE - SOL')]",
      "SEE - SOL",
    );
    if (this.documento === "boleta") {
      const opened = await this.clickMenuStep(
        menuFrame,
        null,
        "Boleta de Venta Electrónica",
      );
      if (!opened) {
        await this.clickMenuStep(menuFrame, null, "Boleta de Venta");
      }

      const consulted = await this.clickMenuStep(
        menuFrame,
        null,
        "Consultar Boleta de Venta y Nota",
      );
      if (!consulted) {
        await this.clickMenuStep(menuFrame, null, "Consultar Boleta");
      }
    } else {
      await this.clickMenuStep(
        menuFrame,
        "/html/body/div[5]/div[2]/div[2]/div/div[1]/div/div/ul/li[12]/li[10]/li/span[contains(normalize-space(.), 'Factura Electrónica')]",
        "Factura Electrónica",
      );
      await this.clickMenuStep(
        menuFrame,
        "/html/body/div[5]/div[2]/div[2]/div/div[1]/div/div/ul/li[12]/li[10]/li[4]/li/span[contains(normalize-space(.), 'Consultar Factura y Nota')]",
        "Consultar Factura y Nota",
      );
    }

    const iframe = menuFrame.locator("iframe#iframeApplication");
    try {
      await iframe.waitFor({ state: "attached", timeout: 40000 });
    } catch {
      throw new Error(
        "SUNAT no abrió el módulo de consulta. Activa \"Mostrar navegador\" para ver el menú y verifica que tu usuario tenga acceso a esa opción.",
      );
    }

    const frame = menuFrame.frameLocator("iframe#iframeApplication");
    await frame.locator("body").waitFor({ state: "visible", timeout: 40000 });
    await page.waitForTimeout(2500);

    const body = (await frame.locator("body").innerText().catch(() => "")) || "";
    if (/no se ha enviado correctamente los parametros de autenticacion/i.test(body)) {
      throw new Error("SUNAT no habilitó la sesión del módulo de consulta.");
    }

    await this.captureModuleUrl(page);
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
      this.log(`Consultando SUNAT (${this.documento}, tipo ${tipo}: ${tipoLabel(tipo, this.documento)})...`);

      const response = await this.context.request.get(this.consultaUrl, {
        params: {
          action: "realizarConsulta",
          buscarPor: "porPer",
          estado: "1",
          fec_desde: desde,
          fec_hasta: hasta,
          tipoConsulta: String(tipo),
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
    if (Number(outer.codeError) !== 0) {
      throw new Error(
        outer.message || outer.msg || `SUNAT devolvió el código ${outer.codeError}.`,
      );
    }

    const data = typeof outer.data === "string" ? JSON.parse(outer.data) : outer.data;
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

module.exports = { SunatClient, TIPOS, TIPO_LABELS, DOCUMENTOS, tipoLabel, normalizeInvoice };
