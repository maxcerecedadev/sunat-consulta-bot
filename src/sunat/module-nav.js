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

    for (let index = 0; index < MENU_URLS.length; index++) {
      if (menuFrame) break;

      const menuUrl = MENU_URLS[index];
      // Recargar MenuInternet.htm justo después del login puede abortar el
      // callback OAuth (AutenticaMenuInternet.htm?code=...) y dejar una
      // pantalla de login. Solo se navega si no estamos ya en e-menu o si se
      // está probando la siguiente variante del menú.
      const alreadyOnMenu = /e-menu\.sunat\.gob\.pe/i.test(page.url());
      if (index > 0 || !alreadyOnMenu) {
        this.log(`Abriendo menú SUNAT: ${menuUrl}`);
        await page
          .goto(menuUrl, { waitUntil: "domcontentloaded", timeout: 60000 })
          .catch((error) => this.log(`No se pudo abrir ${menuUrl}: ${error.message}`));
        await page.waitForTimeout(2000);
      }

      if (/loginMenuSol/i.test(page.url())) {
        const debugInfo = await this.captureDebug(page, "menu");
        this.log("El menú redirigió al login; la sesión SOL no está activa.");
        throw new Error(
          "La sesión SOL expiró o no se pudo iniciar. " +
            `Activa "Mostrar navegador" y verifica el RUC, usuario y clave.${debugInfo}`,
        );
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
      await page.waitForTimeout(1500);
      return;
    }

    if (opened?.frame) {
      const url = new URL(opened.frame.url());
      this.consultaUrl = `${url.origin}${url.pathname}`;
      this.consultaReferer = this.consultaUrl;
      this.log(`Módulo SUNAT: ${this.consultaUrl}`);
      // La URL cambia antes de que el módulo termine de inicializar su sesión.
      await page.waitForTimeout(1500);
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
   */,

  async captureModuleUrl(page, timeoutMs = 30000) {
    const started = Date.now();
    let frames = [];

    while (Date.now() - started < timeoutMs) {
      frames = page
        .frames()
        .filter(
          (frame) =>
            frame !== page.mainFrame() &&
            /^https?:\/\/ww1\.sunat\.gob\.pe/i.test(frame.url()) &&
            // Al abrir el módulo, el iframe pasa primero por este servicio de
            // hora. Si se captura esa URL el POST de descarga termina en 404.
            !/\/time\/gettime\.pl/i.test(frame.url()),
        );

      const moduleFrame =
        frames.find((frame) => /itconsc|consultar|conscpe/i.test(frame.url())) ||
        (this.documento === "boleta"
          ? frames.find((frame) => /bve|boleta/i.test(frame.url()))
          : null);

      if (moduleFrame) {
        try {
          const url = new URL(moduleFrame.url());
          this.consultaUrl = `${url.origin}${url.pathname}`;
          this.consultaReferer = this.consultaUrl;
          this.log(`Módulo SUNAT: ${this.consultaUrl}`);
          return true;
        } catch {
          // La URL del iframe aún no es válida; se reintenta.
        }
      }

      await page.waitForTimeout(500);
    }

    this.log(
      `No se detectó la URL del módulo; se usa ${this.consultaUrl}. ` +
        `Frames: ${frames.map((frame) => frame.url()).join(" | ") || "(ninguno)"}`,
    );
    return false;
  }
};
