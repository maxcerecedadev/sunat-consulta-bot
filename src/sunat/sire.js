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
  sireDocType(tipo) {
    const code = String(tipo);
    if (code === "14") return "07";
    if (code === "16") return "08";
    return this.documento === "boleta" ? "03" : "01";
  },

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

    let invoices = this.parseSireTxt(text, docType);
    if (String(tipo) === "12") {
      invoices = invoices.filter((invoice) =>
        /rechaz|no acept|no v[aá]lid|anulad/i.test(invoice.estado),
      );
    }
    this.log(
      `SIRE devolvió ${invoices.length} comprobante(s)` +
        `${String(tipo) === "12" ? " rechazados" : ""} para ${periodo}.`,
    );
    return invoices;
  },

  async consultarSireVentas({ desde, hasta, tipo = 10 }) {
    const docType =
      String(tipo) === "13" ? "07" : String(tipo) === "15" ? "08" : "03";
    const [, fromMonth, fromYear] = String(desde).split("/").map(Number);
    const [, toMonth, toYear] = String(hasta).split("/").map(Number);
    const fromIso = sunatToIsoDate(desde);
    const toIso = sunatToIsoDate(hasta);

    if (!fromMonth || !fromYear || !toMonth || !toYear) {
      throw new Error("Fecha inválida para SIRE Ventas.");
    }

    // La propuesta RVIE se genera por mes y puede incluir todo el periodo;
    // se filtra localmente por la fecha solicitada (p. ej. un solo día).
    const enRango = (invoice) => {
      const iso = sunatToIsoDate(invoice.fecha);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return true;
      return iso >= fromIso && iso <= toIso;
    };

    const months = [];
    let year = fromYear;
    let month = fromMonth;

    while (year < toYear || (year === toYear && month <= toMonth)) {
      months.push({ year, month });
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
    }

    const invoices = [];

    for (const item of months) {
      const periodo = `${item.year}${String(item.month).padStart(2, "0")}`;
      const lastDay = new Date(item.year, item.month, 0).getDate();
      const fechaIni = `${item.year}-${String(item.month).padStart(2, "0")}-01`;
      const fechaFin = `${item.year}-${String(item.month).padStart(2, "0")}-${String(
        lastDay,
      ).padStart(2, "0")}`;

      this.log(
        `Consultando SIRE Ventas (${tipoLabel(tipo, "boleta")}, periodo ${periodo})...`,
      );

      if (!this.menuTokens.ventas) {
        this.menuTokens.ventas = await this.menuToken({
          code: "60.2.1.1.1",
          description: "Gestión de Ventas e Ingresos Electrónicos",
          parent: "#nivel1_60",
          match: "gestionlibroventas",
        });
      }
      const token = this.menuTokens.ventas;

      const text = await this.descargarPropuestaSire({
        token,
        periodo,
        fechaIni,
        fechaFin,
        docType,
        libro: "ventas",
      });

      const todos = this.parseSireVentasTxt(text, docType);
      let parsed = todos.filter(enRango);
      if (String(tipo) === "12") {
        parsed = parsed.filter((invoice) =>
          /rechaz|no acept|no v[aá]lid|anulad/i.test(invoice.estado),
        );
      }
      invoices.push(...parsed);

      if (String(tipo) === "12") {
        this.log(
          `SIRE Ventas devolvió ${todos.length} comprobante(s) para ${periodo}; ` +
            `${parsed.length} rechazada(s) en el rango solicitado.`,
        );
        if (parsed.length === 0) {
          this.log(
            "SIRE Ventas no reportó boletas rechazadas; la propuesta solo incluye comprobantes informados/aceptados.",
          );
        }
      } else if (todos.length !== parsed.length) {
        this.log(
          `SIRE Ventas devolvió ${todos.length} comprobante(s) para ${periodo}; ` +
            `${parsed.length} están dentro del rango solicitado.`,
        );
      } else {
        this.log(
          `SIRE Ventas devolvió ${parsed.length} comprobante(s) en el rango para ${periodo}.`,
        );
      }
    }

    const seen = new Set();
    return invoices.filter((invoice) => {
      if (seen.has(invoice.id)) return false;
      seen.add(invoice.id);
      return true;
    });
  },

  parseSireTxt(text, docType) {
    return parseSireComprasTxt(text, { docType, ruc: this.ruc });
  },

  parseSireVentasTxt(text, docType) {
    return parseSireVentasTxt(text, { docType, ruc: this.ruc });
  },

  async consultarBoletas({ desde, hasta, tipo = 10 }) {
    // El listado por periodo del módulo nuevo rechaza boletas con 422/103
    // ("Código de comprobante no permitido"). SIRE Ventas entrega el listado
    // y luego cada comprobante se consulta/descarga individualmente.
    return this.consultarSireVentas({ desde, hasta, tipo });
  }
};
