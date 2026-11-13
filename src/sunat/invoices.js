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
  async consultar({ desde, hasta, tipo = 10 }) {
    return this.withRetry(async () => {
      if (this.sire) return this.consultarSire({ desde, hasta, tipo });

      // Las boletas se consultan en el módulo "Consulta de Comprobante de
      // Pago" (consultacpe), no en el SEE-SOL de boletas.
      if (this.documento === "boleta") {
        return this.consultarBoletas({ desde, hasta, tipo });
      }

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
  },

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
};
