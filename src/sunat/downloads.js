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
  async withRetry(operation) {
    try {
      return await operation();
    } catch (error) {
      if (this.closed) throw error;
      if (!/sesión|session|autenticacion|expir/i.test(error.message)) throw error;
      this.log("La sesión expiró; iniciando sesión nuevamente...");
      await this.relogin();
      return operation();
    }
  },

  invoiceForm(invoice, action) {
    return {
      action,
      ruc: String(invoice.ruc_emisor || "").trim(),
      // SEE-SOL usa el código de dos dígitos (03 para boleta); SIRE puede
      // entregarlo como "3".
      tipo: String(invoice.tipo || "").trim().padStart(2, "0"),
      serie: String(invoice.serie || "").trim(),
      numero: String(invoice.numero || "").trim(),
    };
  },

  async downloadZip(invoice) {
    return this.withRetry(async () => {
      const response = await this.ensureActive().request.post(this.consultaUrl, {
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
        throw new Error(
          `No se pudo descargar el XML. ${message || `HTTP ${response.status()}`} (${this.consultaUrl})`,
        );
      }

      if (!body.length || body.subarray(0, 2).toString("latin1") !== "PK") {
        throw new Error("SUNAT devolvió un archivo inválido (no es un ZIP).");
      }

      return body;
    });
  },

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
  },

  async downloadPdf(invoice) {
    return this.withRetry(async () => {
      const response = await this.ensureActive().request.post(this.consultaUrl, {
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
        throw new Error(
          `No se pudo descargar el PDF. ${message || `HTTP ${response.status()}`} (${this.consultaUrl})`,
        );
      }

      if (!body.length || body.subarray(0, 4).toString("latin1") !== "%PDF") {
        throw new Error("SUNAT devolvió un archivo inválido (no es un PDF).");
      }

      return body;
    });
  },

  async descargar(invoice, formato = "xml") {
    if (invoice.sire || invoice.cpe) {
      // `consultacpe` sí entrega los comprobantes propios cuando SUNAT guarda
      // el XML individual (por ejemplo, boletas emitidas por SEE-SOL). Se
      // intenta primero y solo se usa el módulo SEE-SOL como respaldo.
      if (this.esPropioEmisor(invoice)) {
        return this.descargarCpeConRespaldo(invoice, formato);
      }
      return this.descargarCpe(invoice, formato);
    }

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
  },

  async detalle(invoice) {
    if (invoice.sire || invoice.cpe) {
      const xml = this.esPropioEmisor(invoice)
        ? await this.descargarCpeConRespaldo(invoice, "xml")
        : await this.descargarCpe(invoice, "xml");
      return {
        detail: parseUbl(xml.content.toString("utf8")),
        cdr: xml.cdr || null,
        cdrName: xml.cdrName || null,
      };
    }

    const zip = await this.downloadZip(invoice);
    const files = this.extractFromZip(zip);
    return {
      detail: parseUbl(files.xml),
      cdr: files.cdr,
      cdrName: files.cdrName,
    };
  }
};
