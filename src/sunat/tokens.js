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
  jsonHeaders(token) {
    return {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
  },

  consultacpeHeaders(token) {
    return {
      Authorization: `Bearer ${token}`,
      Accept: "application/json, text/plain, */*",
      Origin: "https://e-factura.sunat.gob.pe",
      Referer: "https://e-factura.sunat.gob.pe/",
    };
  },

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
        if (tokenMatch) {
          if (match === "consultacpe") await this.restoreMenuView(page);
          return decodeURIComponent(tokenMatch[1]);
        }
      }

      // El SPA nuevo de consulta CPE guarda el token en sessionStorage, no en
      // la URL. Leerlo ahí evita usar un token viejo que el API rechaza.
      if (match === "consultacpe") {
        const sessionToken = await this.readConsultacpeSessionToken(page);
        if (sessionToken) {
          await this.restoreMenuView(page);
          return sessionToken;
        }
      }

      if (/loginMenuSol/i.test(page.url())) throw new Error("La sesión SOL expiró.");
      await page.waitForTimeout(500);
    }

    throw new Error(`No se pudo obtener el token de SUNAT (${description}).`);
  }

  /**
   * El menú abre el SPA de consulta CPE en el iframe y SUNAT lo deja en una
   * página 404 cuando ya se capturó el token. Se restaura el menú para que la
   * ventana visible no quede mostrando ese error.
   */,

  async restoreMenuView(page) {
    for (const candidate of page.context().pages()) {
      if (candidate === page) continue;
      if (/e-factura\.sunat\.gob\.pe/i.test(candidate.url())) {
        await candidate.close().catch(() => undefined);
      }
    }

    await page
      .goto(MENU_URLS[0], { waitUntil: "domcontentloaded", timeout: 60000 })
      .catch(() => undefined);
    await page.waitForTimeout(1000);
  },

  async readConsultacpeSessionToken(page) {
    const targets = [];
    for (const candidate of page.context().pages()) {
      if (/e-factura\.sunat\.gob\.pe/i.test(candidate.url())) targets.push(candidate);
    }
    for (const frame of page.frames()) {
      if (/e-factura\.sunat\.gob\.pe/i.test(frame.url())) targets.push(frame);
    }

    for (const target of targets) {
      const token = await target
        .evaluate(() => {
          try {
            return (
              sessionStorage.getItem("SUNAT.token") ||
              sessionStorage.getItem("token") ||
              ""
            );
          } catch {
            return "";
          }
        })
        .catch(() => "");
      if (token) return token;
    }

    return "";
  },

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
  },

  async controlcpeToken() {
    if (this.menuTokens.controlcpe) return this.menuTokens.controlcpe;

    const token = await this.menuToken({
      code: "61.1.1.1.1",
      description: "Gestión General",
      parent: "#nivel1_61",
      match: "controlcpe",
    });

    this.menuTokens.controlcpe = token;
    return token;
  }
};
