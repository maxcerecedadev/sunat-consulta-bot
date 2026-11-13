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
  },

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
   */,

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
  },

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
  },

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
  },

  async waitForConsultaModule(page, menuFrame, timeoutMs = 45000) {
    const started = Date.now();
    const isModuleUrl = (value) =>
      /^https?:\/\/ww1\.sunat\.gob\.pe/i.test(value) &&
      !/\/time\/gettime\.pl/i.test(value) &&
      /consultar|itcons|conscpe|bve/i.test(value);

    while (Date.now() - started < timeoutMs) {
      const moduleFrame = page
        .frames()
        .find((frame) => frame !== page.mainFrame() && isModuleUrl(frame.url()));
      if (moduleFrame) return { frame: moduleFrame };

      const otherPage = page
        .context()
        .pages()
        .find((candidate) => candidate !== page && isModuleUrl(candidate.url()));
      if (otherPage) return { page: otherPage };

      // El iframe del menú existe desde antes de abrir el módulo y al inicio
      // apunta a time/gettime.pl. Solo se usa como último recurso, cuando ya
      // se esperó lo suficiente para que cargue la URL real.
      const iframeCount = await menuFrame
        .locator("iframe#iframeApplication")
        .count()
        .catch(() => 0);
      if (iframeCount > 0 && Date.now() - started > 20000) {
        return { locator: menuFrame.frameLocator("iframe#iframeApplication") };
      }

      await page.waitForTimeout(500);
    }

    return null;
  },

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
};
