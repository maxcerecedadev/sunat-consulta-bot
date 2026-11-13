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
  sireCacheTtlMs(periodo) {
    const configured = process.env.SUNAT_SIRE_CACHE_TTL_MS;
    if (configured !== undefined && configured !== "") {
      const parsed = Number(configured);
      // 0 desactiva el caché; cualquier valor inválido también.
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    }

    const now = new Date();
    const currentPeriod = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
    // El mes en curso cambia a diario (nuevos comprobantes), los periodos
    // cerrados son más estables. Se usa una vigencia corta para el mes actual.
    return String(periodo) >= currentPeriod
      ? 60 * 60 * 1000
      : 6 * 60 * 60 * 1000;
  },

  sireCachePath({ libro, periodo, fechaIni, fechaFin, docType }) {
    const safe = (value) =>
      String(value || "")
        .replace(/[^A-Za-z0-9_.-]+/g, "_")
        .slice(0, 60);
    return path.join(
      this.sireCacheDir,
      [
        safe(this.ruc),
        safe(libro),
        safe(periodo),
        safe(docType),
        safe(fechaIni),
        safe(fechaFin),
      ].join("-") + ".txt.gz",
    );
  },

  readSireCache(cachePath, ttlMs) {
    if (!cachePath || ttlMs <= 0) return null;

    try {
      const stat = fs.statSync(cachePath);
      if (Date.now() - stat.mtimeMs > ttlMs) return null;
      const text = zlib
        .gunzipSync(fs.readFileSync(cachePath))
        .toString("utf8");
      return { text, savedAt: stat.mtimeMs };
    } catch {
      return null;
    }
  },

  writeSireCache(cachePath, text) {
    let tmp = "";
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      tmp = `${cachePath}.${process.pid}.${Date.now()}.${Math.random()
        .toString(36)
        .slice(2)}.tmp`;
      fs.writeFileSync(tmp, zlib.gzipSync(Buffer.from(String(text || ""), "utf8")));
      fs.renameSync(tmp, cachePath);
    } catch (error) {
      if (tmp) fs.rmSync(tmp, { force: true });
      this.log(`No se pudo guardar el caché de la propuesta SIRE: ${error.message}`);
    }
  },

  async descargarPropuestaSire({
    token,
    periodo,
    fechaIni,
    fechaFin,
    docType,
    libro = "compras",
  }) {
    const headers = this.jsonHeaders(token);
    const codLibro = libro === "ventas" ? "140000" : "080000";

    // RVIE y RCE usan servicios de exportación distintos.
    const exportUrl =
      libro === "ventas"
        ? `${SIRE_API}/rvie/propuesta/web/propuesta/${periodo}/exportapropuesta`
        : `${SIRE_API}/rce/propuesta/web/propuesta/${periodo}/exportacioncomprobantepropuesta`;
    const exportParams =
      libro === "ventas"
        ? {
            codTipoArchivo: "0",
            codTipoCDP: docType,
            fecDocumentoDesde: isoToSunatDate(fechaIni),
            fecDocumentoHasta: isoToSunatDate(fechaFin),
          }
        : {
            codTipoArchivo: "0",
            codOrigenEnvio: "2",
            fecEmisionIni: fechaIni,
            fecEmisionFin: fechaFin,
            codTipoCDP: docType,
          };

    // La generación de la propuesta es asíncrona en SUNAT. En periodos con
    // muchos comprobantes el ticket puede tardar varios minutos; si SUNAT lo
    // marca como expirado hay que solicitar uno nuevo.
    const waitMs = Math.max(
      30000,
      Number(process.env.SUNAT_SIRE_TICKET_WAIT_MS) || 210000,
    );
    const pollMs = Math.max(
      1000,
      Number(process.env.SUNAT_SIRE_TICKET_POLL_MS) || 3000,
    );
    const maxTickets = Math.max(
      1,
      Number(process.env.SUNAT_SIRE_TICKET_RETRIES) || 2,
    );

    const cacheTtlMs = this.sireCacheTtlMs(periodo);
    const cachePath = this.sireCachePath({
      libro,
      periodo,
      fechaIni,
      fechaFin,
      docType,
    });
    const cached = this.readSireCache(cachePath, cacheTtlMs);
    if (cached) {
      const ageMin = Math.max(0, Math.round((Date.now() - cached.savedAt) / 60000));
      this.log(
        `Usando propuesta SIRE en caché (${libro === "ventas" ? "RVIE" : "RCE"}, ${periodo}, ${ageMin} min).`,
      );
      return cached.text;
    }

    const cacheAndReturn = (text) => {
      if (cacheTtlMs > 0) {
        this.writeSireCache(cachePath, text);
        this.log(
          `Propuesta SIRE guardada en caché (${libro === "ventas" ? "RVIE" : "RCE"}, ${periodo}).`,
        );
      }
      return text;
    };

    const requestExportTicket = async () => {
      this.log(
        `Solicitando propuesta SIRE (${libro === "ventas" ? "RVIE" : "RCE"}, ${periodo})...`,
      );

      const exportRes = await this.context.request.get(exportUrl, {
        params: exportParams,
        headers,
        timeout: 120000,
      });

      const exportText = await exportRes.text();
      if (!exportRes.ok()) {
        if (isMissingSireFile(exportText)) {
          this.log(`SIRE no tiene propuesta para ${periodo}; se devuelve vacío.`);
          return { numTicket: "", exportText: "", vacio: true };
        }

        throw new Error(
          `SIRE no pudo exportar la propuesta (${exportRes.status()}): ${exportText
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 200)}`,
        );
      }

      let numTicket = "";
      try {
        const exportData = JSON.parse(exportText);
        numTicket =
          exportData.numTicket ||
          exportData.ticket ||
          exportData.numTicketEnvio ||
          "";
      } catch {
        // Se informa abajo con el texto original.
      }

      return { numTicket, exportText, vacio: false };
    };

    const reporteEnTicket = (reg) => {
      const reportes = Array.isArray(reg.archivoReporte)
        ? reg.archivoReporte
        : reg.archivoReporte
          ? [reg.archivoReporte]
          : [];
      if (reportes.length > 0) return reportes[0];

      // Algunas respuestas de SIRE solo informan el nombre del reporte dentro
      // de detalleTicket; se usa cuando el proceso ya terminó.
      const terminado =
        /^(04|06)$/.test(String(reg.codEstadoProceso || "")) ||
        /terminad|concluid|sin errores/i.test(String(reg.desEstadoProceso || ""));
      if (terminado && reg.detalleTicket && reg.detalleTicket.nomArchivoReporte) {
        return {
          nomArchivoReporte: reg.detalleTicket.nomArchivoReporte,
          codTipoAchivoReporte: reg.detalleTicket.codTipoArchivoReporte,
        };
      }

      return null;
    };

    let reg = null;
    let file = null;
    let lastState = "";

    for (let intento = 0; intento < maxTickets && !file; intento++) {
      const ticket = await requestExportTicket();
      if (ticket.vacio) return cacheAndReturn("");
      if (!ticket.numTicket) {
        throw new Error(
          `SIRE no devolvió un ticket de descarga. ${ticket.exportText.slice(0, 200)}`,
        );
      }

      const numTicket = ticket.numTicket;
      this.log(`SIRE generó el ticket; esperando la propuesta (${numTicket})...`);

      const deadline = Date.now() + waitMs;
      let expirado = false;

      while (Date.now() < deadline) {
        await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));

        const statusParams = {
          perIni: periodo,
          perFin: periodo,
          page: "1",
          perPage: "20",
          numTicket,
        };
        if (libro === "ventas") {
          statusParams.codLibro = "140000";
          statusParams.codOrigenEnvio = "2";
        }

        const statusRes = await this.context.request.get(
          `${SIRE_API}/rvierce/gestionprocesosmasivos/web/masivo/consultaestadotickets`,
          {
            params: statusParams,
            headers,
            timeout: 120000,
          },
        );

        if (!statusRes.ok()) {
          this.log(
            `SIRE respondió ${statusRes.status()} al consultar el ticket; se reintenta...`,
          );
          continue;
        }

        const status = await statusRes.json().catch(() => null);
        if (!status || !Array.isArray(status.registros)) {
          this.log("SIRE devolvió una respuesta inválida al consultar el ticket; se reintenta...");
          continue;
        }

        reg =
          status.registros.find(
            (item) => String(item.numTicket) === String(numTicket),
          ) ||
          status.registros[0] ||
          null;

        if (!reg) {
          if (lastState !== "sin registro") {
            lastState = "sin registro";
            this.log(`SIRE aún no registra el ticket ${numTicket}; se sigue esperando...`);
          }
          continue;
        }

        const estado = [reg.codEstadoProceso, reg.desEstadoProceso]
          .filter(Boolean)
          .join(" - ");
        if (estado && estado !== lastState) {
          lastState = estado;
          this.log(`SIRE ticket ${numTicket}: ${estado}.`);
        }

        // "Procesado sin errores" también contiene la palabra "errores": solo
        // se considera fallo el estado 03 o un texto de error explícito.
        const estadoTexto = String(reg.desEstadoProceso || "");
        const esError =
          String(reg.codEstadoProceso || "") === "03" ||
          /fall|rechaz/i.test(estadoTexto) ||
          (/error/i.test(estadoTexto) && !/sin\s+errores/i.test(estadoTexto));
        if (esError) {
          throw new Error(
            `SIRE no pudo generar la propuesta: ${reg.desEstadoProceso}`,
          );
        }

        const reporte = reporteEnTicket(reg);
        if (reporte) {
          file = reporte;
          this.log("SIRE generó la propuesta; descargando archivo...");
          break;
        }

        if (/expir/i.test(`${reg.codEstadoProceso || ""} ${reg.desEstadoProceso || ""}`)) {
          this.log(`SIRE expiró el ticket ${numTicket}; se solicita uno nuevo...`);
          expirado = true;
          break;
        }
      }

      if (!file && !expirado) break;
    }

    if (!file) {
      throw new Error(
        `SIRE no generó la propuesta a tiempo${
          lastState ? ` (último estado: ${lastState})` : ""
        }. Intenta nuevamente.`,
      );
    }

    const downloadRes = await this.context.request.get(
      `${SIRE_API}/rvierce/gestionprocesosmasivos/web/masivo/archivoreporte`,
      {
        params: {
          nomArchivoReporte: file.nomArchivoReporte,
          codTipoArchivoReporte:
            file.codTipoAchivoReporte || file.codTipoArchivoReporte || "null",
          codLibro,
          perTributario: reg.perTributario || periodo,
          codProceso: reg.codProceso,
          numTicket: reg.numTicket || numTicket,
        },
        headers,
        timeout: 120000,
      },
    );

    const body = await downloadRes.body();
    if (!downloadRes.ok() || body.subarray(0, 2).toString("latin1") !== "PK") {
      const text = body
        .toString("utf8")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      if (isMissingSireFile(text)) {
        this.log(
          `SIRE no tiene el archivo de propuesta para ${periodo}; se devuelve vacío.`,
        );
        return cacheAndReturn("");
      }

      throw new Error(
        `SIRE no devolvió la propuesta (${downloadRes.status()}). ${text.slice(0, 200)}`,
      );
    }

    const zip = new AdmZip(body);
    const entry =
      zip.getEntries().find((item) => /\.txt$/i.test(item.entryName)) ||
      zip.getEntries()[0];

    if (!entry) throw new Error("El ZIP de SIRE no contiene la propuesta.");

    return cacheAndReturn(entry.getData().toString("utf8"));
  }
};
