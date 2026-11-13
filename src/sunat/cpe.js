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

    // SUNAT identifica el tipo de comprobante con dos dígitos (03 = boleta).
    // SIRE a veces entrega "3" sin el cero inicial, así que se prueban ambas
    // variantes empezando por la normalizada.
    const tiposBase = tipoCpeVariants(invoice.tipo);

    const cache = this.cpeDownloadPattern;
    const tipos =
      cache && tiposBase.includes(cache.tipo)
        ? [cache.tipo, ...tiposBase.filter((tipo) => tipo !== cache.tipo)]
        : tiposBase;

    let lastError = null;
    // El filtro es codFiltroCpe: 1 = emisor, 2 = receptor. Las boletas de
    // SIRE Ventas se consultan como emisor.
    const filtrosBase = filtrosCpe(invoice.emitido);
    const filtros =
      cache && filtrosBase.includes(cache.filtro)
        ? [cache.filtro, ...filtrosBase.filter((filtro) => filtro !== cache.filtro)]
        : filtrosBase;

    for (const filtro of filtros) {
      for (const tipo of tipos) {
        for (const numero of numbers) {
          const url = buildCpeDescargaUrl({
            baseUrl: CONSULTACPE_API,
            ruc: invoice.ruc_emisor,
            tipo,
            serie: invoice.serie,
            numero,
            filtro,
            formato: String(suffix || "").replace(/^\//, ""),
          });

        for (let attempt = 0; attempt < 6; attempt++) {
          // Se procesa 1 a 1, así que basta un desfase corto para no saturar.
          await sleep(200 + Math.floor(Math.random() * 300));

          const response = await this.ensureActive().request.get(url, {
            headers: this.consultacpeHeaders(token),
            timeout: 120000,
          });

          if (response.ok()) {
            const data = await response.json().catch(() => null);
            if (!data || !data.valArchivo) {
              throw new Error("SUNAT no devolvió el archivo del comprobante.");
            }
            this.cpeDownloadPattern = { filtro, tipo };
            return Buffer.from(data.valArchivo, "base64");
          }

          const body = await response.text();
          const message = body
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 300);

          if (response.status() === 401) {
            this.menuTokens.consultacpe = null;
            token = await this.consultacpeToken();
            continue;
          }

          lastError = new Error(
            `${message || `SUNAT respondió ${response.status()} al descargar el comprobante.`} (${url})`,
          );

          if (response.status() === 404 || response.status() === 400) break;

          if (response.status() >= 500 || response.status() === 429) {
            const wait = [5000, 10000, 20000, 30000, 45000, 60000][attempt] || 60000;
            this.log(
              `SUNAT respondió ${response.status()}${
                message ? `: ${message.slice(0, 160)}` : ""
              }; reintentando en ${Math.round(wait / 1000)}s...`,
            );
            await sleep(wait + Math.floor(Math.random() * 2000));
            continue;
          }

            break;
          }
        }
      }
    }

    // Respaldo: el API individual puede responder 500 para comprobantes
    // recibidos. El módulo controlcpe entrega el mismo ZIP por otro endpoint.
    if (invoice.cpe || invoice.sire) {
      this.log(
        `Se intenta descargar ${invoice.serie}-${invoice.numero} por controlcpe...`,
      );
      try {
        return await this.descargarControlcpe(invoice);
      } catch (error) {
        lastError = lastError || error;
      }
    }

    throw lastError || new Error("No se pudo descargar el comprobante.");
  },

  async descargarControlcpe(invoice) {
    const token = await this.controlcpeToken();
    const tipos = tipoCpeVariants(invoice.tipo);

    let lastError = null;
    const filtros = [...filtrosCpe(invoice.emitido), ""];

    for (const filtro of filtros) {
      for (const tipo of tipos) {
        const id = buildCpeComprobanteId({
          ruc: invoice.ruc_emisor,
          tipo,
          serie: invoice.serie,
          numero: invoice.numero,
          filtro,
        });
        const response = await this.ensureActive().request.get(
          `${CONTROLCPE_API}/consultaxml/${id}`,
          {
            headers: this.consultacpeHeaders(token),
            timeout: 120000,
          },
        );

        const body = await response.body();
        if (
          response.ok() &&
          body.length &&
          body.subarray(0, 2).toString("latin1") === "PK"
        ) {
          return body;
        }

        const message = body
          .toString("utf8")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 200);
        lastError = new Error(
          `${message || `SUNAT respondió ${response.status()} al descargar el comprobante.`} (${id})`,
        );
      }
    }

    throw lastError || new Error("No se pudo descargar el comprobante.");
  },

  async descargarCpe(invoice, formato = "xml") {
    if (this.closed) {
      throw new Error("Consulta cancelada: la sesión de SUNAT ya está cerrada.");
    }

    try {
      return await this.withRetry(async () => {
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
    } catch (error) {
      if (!invoice.cpe) {
        if (invoice.sire && !invoice.emitido) {
          throw new Error(
            `${error.message} | Si el comprobante es físico o el proveedor no ` +
              "lo informó como CPE, SUNAT no tiene XML/PDF disponible.",
          );
        }
        throw error;
      }

      // El módulo SEE-SOL de boletas (ol-ti-itconscpemypebve) fue retirado por
      // SUNAT y ya no existe. Un 404 en el API individual de una boleta
      // significa que SUNAT no guarda XML/PDF/CDR por boleta: las boletas se
      // informan mediante Resumen Diario y solo existe el resumen.
      if (esBoleta(invoice.tipo) && /404|resource not found/i.test(error.message)) {
        const missing = new Error(
          `SUNAT no tiene XML/PDF/CDR individual disponible para la boleta ` +
            `${invoice.serie}-${invoice.numero}. Las boletas informadas por ` +
            `Resumen Diario no se almacenan de forma individual; si se emitió ` +
            `por SEE-SOL, verifica que esté aceptada en SUNAT.`,
        );
        missing.permanent = true;
        throw missing;
      }

      throw error;
    }
  },

  async descargarSire(invoice, formato = "xml") {
    return this.descargarCpe(invoice, formato);
  }
};
