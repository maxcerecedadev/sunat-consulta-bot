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
  async open() {
    if (!this.ruc || !this.solUser || !this.solPassword) {
      throw new Error("Faltan las credenciales SOL (RUC, usuario y clave).");
    }

    this.closed = false;

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
  },

  async startSession(forceLogin = false) {
    if (this.context) {
      await this.context.close().catch(() => undefined);
      this.context = null;
    }

    this.buzonFrame = null;
    this.buzonDetailRouteHandler = null;
    this.allowBuzonDetail = false;
    this.cpeDownloadPattern = null;
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
        } else if (this.documento !== "boleta") {
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
        } else if (!this.sire && this.documento !== "boleta") {
          await this.openModuleWithRetry(this.page);
        }
        await this.saveState();
      } catch (error) {
        // No dejar una sesión guardada que pueda volver a romper el login.
        fs.rmSync(this.statePath, { force: true });
        throw error;
      }
    }
  },

  async relogin() {
    if (this.browser) {
      await this.startSession(true);
    }
  },

  async close() {
    this.closed = true;
    if (this.context) await this.context.close().catch(() => undefined);
    if (this.browser) await this.browser.close().catch(() => undefined);
    this.context = null;
    this.page = null;
    this.browser = null;
    this.buzonFrame = null;
    this.buzonDetailRouteHandler = null;
    this.allowBuzonDetail = false;
  },

  ensureActive() {
    if (this.closed || !this.context) {
      throw new Error("Consulta cancelada: la sesión de SUNAT ya está cerrada.");
    }
    return this.context;
  },

  async saveState() {
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      await this.context.storageState({ path: this.statePath });
      fs.chmodSync(this.statePath, 0o600);
    } catch (error) {
      this.log(`No se pudo guardar la sesión: ${error.message}`);
    }
  },

  async openModuleWithRetry(page) {
    try {
      await this.openModule(page, { navigate: false });
    } catch (error) {
      if (!/sesión|session|login|menú/i.test(error.message)) throw error;
      this.log(`No se abrió el menú (${error.message}); reintentando el login...`);
      await this.login(page);
      await this.openModule(page, { navigate: false });
    }
  },

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
  },

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

    try {
      this.loginOAuthState = new URL(page.url()).searchParams.get("state") || "";
    } catch {
      this.loginOAuthState = "";
    }

    await this.fillLoginForm(page);

    // El login de SUNAT puede navegar en la misma pestaña o abrir el menú en
    // una pestaña nueva. Se espera hasta 30s a que aparezca e-menu.
    let activePage = null;
    let loginRetried = false;
    let oauthCompleted = false;
    const deadline = Date.now() + 30000;

    const oauthCode = (url) => {
      try {
        const parsed = new URL(url);
        if (!/api-seguridad\.sunat\.gob\.pe/i.test(parsed.hostname)) return null;
        const code = parsed.searchParams.get("code");
        if (!code) return null;
        return {
          code,
          state: parsed.searchParams.get("state") || this.loginOAuthState || "",
        };
      } catch {
        return null;
      }
    };

    const isRealMenu = (url) =>
      /e-menu\.sunat\.gob\.pe/i.test(url) && !/AutenticaMenuInternet/i.test(url);

    while (Date.now() < deadline) {
      const pages = [...context.pages()].reverse();
      const menuPage = pages.find((candidate) => isRealMenu(candidate.url()));

      if (menuPage) {
        activePage = menuPage;
        break;
      }

      // Tras validar credenciales, SUNAT puede quedar en
      // api-seguridad.sunat.gob.pe/?code=... con la pantalla "Bienvenidos a
      // SUNAT". Hay que completar el callback OAuth del menú manualmente.
      if (!oauthCompleted) {
        const pending = pages
          .map((candidate) => ({ page: candidate, oauth: oauthCode(candidate.url()) }))
          .find((item) => item.oauth);

        if (pending) {
          oauthCompleted = true;
          await this.completeMenuLogin(
            pending.page,
            pending.oauth.code,
            pending.oauth.state,
          );
          continue;
        }
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
        try {
          this.loginOAuthState =
            new URL(newLoginPage.url()).searchParams.get("state") || "";
        } catch {
          // Se conserva el state capturado en la pestaña original.
        }
        await this.fillLoginForm(newLoginPage).catch((error) =>
          this.log(`No se pudo completar el login en la nueva pestaña: ${error.message}`),
        );
        continue;
      }

      await page.waitForTimeout(500);
    }

    if (!activePage) {
      // La pestaña api-seguridad/?code=... contiene el código OAuth que
      // permite completar el login del menú; se prefiere para reintentar.
      activePage =
        [...context.pages()]
          .reverse()
          .find((candidate) => oauthCode(candidate.url())) || null;

      if (!activePage) {
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
    }

    this.page = activePage;
    this.log(`Pestaña activa tras el login: ${activePage.url()}`);
    await activePage.waitForLoadState("domcontentloaded").catch(() => undefined);

    if (!isRealMenu(activePage.url()) && !/loginMenuSol/i.test(activePage.url())) {
      const pending = oauthCode(activePage.url());
      if (pending) {
        await this.completeMenuLogin(activePage, pending.code, pending.state);
      } else if (!/e-menu\.sunat\.gob\.pe/i.test(activePage.url())) {
        // Si el SSO ya quedó autenticado, abrir el menú puede completar la
        // sesión sin volver a pedir credenciales.
        await activePage
          .goto(MENU_URLS[0], { waitUntil: "domcontentloaded", timeout: 60000 })
          .catch(() => undefined);
        await activePage.waitForTimeout(2000);
        const after = oauthCode(activePage.url());
        if (after) {
          await this.completeMenuLogin(activePage, after.code, after.state);
        }
      }

      await activePage
        .waitForURL((url) => isRealMenu(url.href), { timeout: 90000 })
        .catch(() => undefined);
    }
    await activePage.waitForTimeout(2500);

    const body = (await activePage.locator("body").innerText().catch(() => "")) || "";
    const loginError = await this.readLoginError(activePage);

    if (loginError) {
      throw new Error(`SUNAT rechazó el acceso SOL: ${loginError}`);
    }

    if (
      /clave\s*(sol)?\s*(incorrect|inválid)|usuario\s*(incorrect|inválid)|bloquead/i.test(body) ||
      /loginMenuSol/i.test(activePage.url())
    ) {
      throw new Error(
        "No se pudo iniciar sesión en SUNAT SOL. Revisa el RUC, usuario y clave.",
      );
    }

    if (!isRealMenu(activePage.url())) {
      const debugInfo = await this.captureDebug(activePage, "login");
      let currentUrl = activePage.url();
      try {
        const parsed = new URL(currentUrl);
        currentUrl = `${parsed.origin}${parsed.pathname}`;
        if (parsed.search) currentUrl += "?...";
      } catch {
        // Se muestra la URL tal cual si no se puede parsear.
      }

      throw new Error(
        `No se abrió el menú de SUNAT tras el login (URL: ${currentUrl}). ` +
          `Revisa el RUC, usuario y clave; si persiste activa "Mostrar navegador".${debugInfo}`,
      );
    }

    this.log(`Sesión SOL iniciada (${activePage.url()}).`);
  },

  async completeMenuLogin(page, code, state) {
    if (!code) return;

    const callback = new URL(
      "https://e-menu.sunat.gob.pe/cl-ti-itmenu/AutenticaMenuInternet.htm",
    );
    callback.searchParams.set("code", code);
    if (state) callback.searchParams.set("state", state);

    this.log("Completando el login OAuth del menú SUNAT...");
    await page
      .goto(callback.toString(), {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      })
      .catch((error) =>
        this.log(`No se pudo completar el login OAuth: ${error.message}`),
      );
    await page.waitForTimeout(2500);
  },

  async readLoginError(page) {
    const box = page.locator("#divMensajeError");
    if ((await box.count().catch(() => 0)) === 0) return "";
    if (!(await box.first().isVisible().catch(() => false))) return "";

    const text = await page
      .locator("#spanMensajeError")
      .first()
      .innerText()
      .catch(() => "");
    return text.replace(/\s+/g, " ").trim();
  }
};
