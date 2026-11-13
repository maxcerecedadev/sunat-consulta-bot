"use strict";

require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { exec, execFile } = require("child_process");
const { ZipArchive } = require("archiver");
const {
  SunatClient,
  TIPOS,
  TIPO_LABELS,
  DOCUMENTOS,
  TIPOS_RECIBIDOS,
  tipoLabel,
} = require("../sunat-client");
const { parseUbl } = require("../ubl");
const { parseDate } = require("../dates");
const { ensureDir, safeName, sleep } = require("../util");
const {
  readEmpresas,
  getEmpresa,
  createEmpresa,
  updateEmpresa,
  deleteEmpresa,
} = require("../empresas");
const {
  checkAll,
  checkEmpresa,
  getPreparedItems,
  decorateItems,
  sendPrepared,
  attachmentFile,
} = require("../buzon-service");
const { readAllState, markSent } = require("../buzon-store");
const { whatsapp } = require("../whatsapp-baileys");
const {
  writeJson,
  writeCsv,
  summarizeJob,
  buildRows,
  VOUCHER_COLUMNS,
  ITEM_COLUMNS,
} = require("../exporters");


const { clients, DATA_DIR } = require("./state");
const { jobStats } = require("./helpers");

async function runJob(job, credentials, options) {
  if (job.cancelled) {
    job.status = "cancelled";
    job.message = "Consulta cancelada.";
    writeOutputs(job);
    return;
  }

  const client = new SunatClient({
    ruc: credentials.ruc,
    solUser: credentials.user,
    solPassword: credentials.password,
    documento: credentials.documento,
    sire: options.sire,
    headless: options.headless,
    statePath: path.join(DATA_DIR, ".session", `${credentials.ruc}.json`),
    dataDir: DATA_DIR,
    log: (message) => {
      job.logs.push({ at: new Date().toISOString(), message });
      if (job.logs.length > 200) job.logs.shift();
    },
  });

  clients.set(job.id, client);

  try {
    job.status = "login";
    job.message = "Iniciando sesión en SUNAT...";
    await client.open();

    job.status = "listing";
    job.message = "Consultando comprobantes en SUNAT...";
    let invoices = await client.consultar({
      desde: options.desde.sunat,
      hasta: options.hasta.sunat,
      tipo: options.tipo,
    });

    if (options.max) invoices = invoices.slice(0, options.max);

    job.total = invoices.length;
    job.message = invoices.length
      ? `Procesando ${invoices.length} comprobante(s)...`
      : "SUNAT no devolvió comprobantes para el rango seleccionado.";

    if (invoices.length === 0) {
      job.status = "done";
      job.stats = jobStats(job);
      writeOutputs(job);
      return;
    }

    job.status = "processing";

    const processInvoice = async (invoice) => {
      if (job.cancelled) {
        throw new Error("Consulta cancelada.");
      }

      const record = {
        id: invoice.id,
        tipo: invoice.tipo,
        tipo_label: invoice.tipo_label,
        serie: invoice.serie,
        numero: invoice.numero,
        numero_desc: invoice.numero_desc,
        fecha: invoice.fecha,
        ruc_emisor: invoice.ruc_emisor,
        emisor: invoice.emisor,
        ruc_receptor: invoice.ruc_receptor,
        receptor: invoice.receptor,
        total: invoice.total,
        moneda: invoice.moneda,
        estado: invoice.estado,
        detail: null,
        files: {},
        error: null,
        permanent: false,
      };

      if (!options.soloListar) {
        if (options.sire || options.cpe) {
          client.log(`Descargando ${invoice.numero_desc}...`);
        }
        const base = safeName(invoice);

        try {
          const xml = await client.descargar(invoice, "xml");

          if (options.descargarXml) {
            const xmlPath = path.join(job.outputDir, "xml", `${base}.xml`);
            fs.writeFileSync(xmlPath, xml.content);
            record.files.xml = `xml/${base}.xml`;
          }

          try {
            record.detail = parseUbl(xml.content.toString("utf8"));
          } catch (error) {
            record.error = `XML descargado, pero no se pudo leer el detalle: ${error.message}`;
          }

          // El listado del portal no siempre trae razón social, total ni
          // estado; el XML sí. Se completa el registro para la tabla y los
          // exports sin cambiar `tipo`, que se usa para descargar.
          if (record.detail) {
            const detail = record.detail;
            record.tipo_label = TIPO_LABELS[detail.tipo] || record.tipo_label;
            record.fecha = record.fecha || sunatDate(detail.fecha);
            record.emisor = record.emisor || detail.emisor.name || "";
            record.ruc_emisor = record.ruc_emisor || detail.emisor.doc_number || "";
            record.receptor = record.receptor || detail.cliente.name || "";
            record.ruc_receptor = record.ruc_receptor || detail.cliente.doc_number || "";
            record.total = record.total ?? detail.totals.total;
            record.moneda = record.moneda || detail.moneda || "";
            record.estado = record.estado || "Aceptado";
          }

          if (xml.cdr) {
            const cdrPath = path.join(job.outputDir, "cdr", `R-${base}.xml`);
            fs.writeFileSync(cdrPath, xml.cdr, "utf8");
            record.files.cdr = `cdr/R-${base}.xml`;
          }
        } catch (error) {
          if (isBrowserClosedError(error)) throw error;
          record.error = `XML: ${error.message}`;
          if (error.permanent) record.permanent = true;
        }

        // Si el XML falló, el CDR puede seguir disponible por separado.
        if ((options.sire || options.cpe) && !record.files.cdr && !record.permanent) {
          try {
            const cdr = await client.descargar(invoice, "cdr");
            const cdrPath = path.join(job.outputDir, "cdr", `R-${base}.xml`);
            fs.writeFileSync(cdrPath, cdr.content);
            record.files.cdr = `cdr/R-${base}.xml`;
          } catch (error) {
            if (isBrowserClosedError(error)) throw error;
            record.error = [record.error, `CDR: ${error.message}`].filter(Boolean).join(" | ");
            if (error.permanent) record.permanent = true;
          }
        }

        // El PDF se intenta aunque el XML haya fallado.
        if (options.descargarPdf && !record.permanent) {
          try {
            const pdf = await client.descargar(invoice, "pdf");
            const pdfPath = path.join(job.outputDir, "pdf", `${base}.pdf`);
            fs.writeFileSync(pdfPath, pdf.content);
            record.files.pdf = `pdf/${base}.pdf`;
          } catch (error) {
            if (isBrowserClosedError(error)) throw error;
            record.error = [record.error, `PDF: ${error.message}`].filter(Boolean).join(" | ");
            if (error.permanent) record.permanent = true;
          }
        }
      }

      return record;
    };

    // SIRE/consultacpe responde lento (~10 s por archivo); se procesan varios
    // comprobantes en paralelo para que 100 compras no tarden una hora.
    // Las boletas se consultan una por una (1 a 1) para evitar rechazos de SUNAT.
    const concurrency = options.sire
      ? Math.min(Math.max(Number(process.env.SUNAT_CONCURRENCY || 2), 1), 5)
      : 1;

    const processed = [];

    for (let index = 0; index < invoices.length; index += concurrency) {
      if (job.cancelled) break;

      const chunk = invoices.slice(index, index + concurrency);
      const items = await Promise.all(
        chunk.map(async (invoice) => ({
          invoice,
          record: await processInvoice(invoice),
        })),
      );

      for (const item of items) {
        job.invoices.push(item.record);
        processed.push(item);
        job.processed = job.invoices.length;
        job.message = `${job.processed} de ${job.total} comprobante(s) procesado(s)...`;
      }

      await sleep(options.sire || options.cpe ? 800 : 300);
    }

    // SIRE/consultacpe devuelve 500 intermitentes. Se reintentan una vez, de
    // forma secuencial, solo los comprobantes que quedaron con error.
    if ((options.sire || options.cpe) && !job.cancelled) {
      const failed = processed.filter(
        (item) => item.record.error && !item.record.permanent,
      );
      const noRetry = processed.filter((item) => item.record.permanent);

      if (noRetry.length > 0) {
        client.log(
          `${noRetry.length} comprobante(s) sin archivo individual en SUNAT; ` +
            "no se reintentan.",
        );
      }

      if (failed.length > 0) {
        client.log(`Reintentando ${failed.length} comprobante(s) con error...`);
        job.message = `Reintentando ${failed.length} comprobante(s) con error...`;

        for (const item of failed) {
          if (job.cancelled) break;
          await sleep(5000);
          client.log(`Reintentando ${item.invoice.numero_desc}...`);

          const retry = await processInvoice(item.invoice);
          const index = job.invoices.findIndex((record) => record.id === item.record.id);
          if (index >= 0) job.invoices[index] = retry;

          const pending = job.invoices.filter((record) => record.error).length;
          job.message = `Reintento: ${pending} comprobante(s) con error...`;
        }
      }
    }

    const stats = jobStats(job);
    job.stats = stats;
    const errorCount = stats.errors;
    const sinArchivos =
      !options.soloListar && job.invoices.length > 0 && stats.withFiles === 0;

    if (job.cancelled) {
      job.status = "cancelled";
      job.message = "Consulta cancelada.";
    } else if (sinArchivos) {
      const firstError = job.invoices.find((record) => record.error)?.error;
      const allPermanent =
        job.invoices.length > 0 && job.invoices.every((record) => record.permanent);
      job.status = "error";
      job.error = [
        "No se descargó ningún archivo XML, PDF ni CDR.",
        firstError ? `Primer error: ${firstError}` : "",
      ]
        .filter(Boolean)
        .join(" ")
        .slice(0, 600);
      job.message = allPermanent
        ? `SUNAT no tiene XML/PDF/CDR individual para ${job.invoices.length} boleta(s); ` +
          "revisa el detalle (pueden estar informadas por Resumen Diario)."
        : errorCount > 0
          ? `No se descargó ningún archivo: ${errorCount} comprobante(s) con error.`
          : "No se descargó ningún archivo; revisa el detalle de la consulta.";
    } else if (options.soloListar) {
      job.status = "done";
      job.message =
        `Consulta completada en modo solo listado: ${job.invoices.length} ` +
        "comprobante(s) sin XML/PDF/CDR.";
    } else {
      job.status = "done";
      job.message =
        errorCount > 0
          ? `Consulta completada con ${errorCount} comprobante(s) con error; ` +
            `${stats.files} archivo(s) descargado(s).`
          : `Consulta completada: ${stats.files} archivo(s) descargado(s).`;
    }
    writeOutputs(job);
  } catch (error) {
    if (job.cancelled) {
      job.status = "cancelled";
      job.message = "Consulta cancelada.";
    } else if (isBrowserClosedError(error)) {
      job.status = "error";
      job.message = "Se cerró el navegador de SUNAT; la consulta se detuvo.";
      job.error =
        "El navegador de SUNAT se cerró durante la consulta. " +
        "Vuelve a ejecutarla y no cierres la ventana hasta que termine.";
    } else {
      job.status = "error";
      job.error = error.message;
      job.message = "No se pudo completar la consulta.";
    }
    writeOutputs(job);
  } finally {
    clients.delete(job.id);
    await client.close();
  }
}

function writeOutputs(job) {
  const stats = jobStats(job);
  job.stats = stats;

  const results = job.invoices.map((record) => ({
    invoice: record,
    detail: record.detail,
    xmlFile: record.files.xml || "",
    pdfFile: record.files.pdf || "",
    cdrFile: record.files.cdr || "",
    error: record.error || "",
  }));

  const rows = buildRows(results);

  writeJson(path.join(job.outputDir, "comprobantes.json"), {
    meta: {
      ruc: job.options.ruc,
      tipo: job.options.tipo,
      documento: job.options.documento,
      tipo_label: tipoLabel(job.options.tipo, job.options.documento),
      desde: job.options.desde,
      hasta: job.options.hasta,
      generated_at: new Date().toISOString(),
      cancelled: job.cancelled,
      stats,
    },
    vouchers: job.invoices,
  });

  writeCsv(path.join(job.outputDir, "comprobantes.csv"), rows.vouchers, VOUCHER_COLUMNS);
  writeCsv(path.join(job.outputDir, "items.csv"), rows.items, ITEM_COLUMNS);
  writeCsv(
    path.join(job.outputDir, "errores.csv"),
    job.invoices
      .filter((record) => record.error)
      .map((record) => ({
        serie: record.serie,
        numero: record.numero,
        tipo: record.tipo,
        etapa: "descarga",
        error: record.error,
      })),
    ["serie", "numero", "tipo", "etapa", "error"],
  );

  writeJobReadme(job, stats);
  writeJobFile(job);
}

/**
 * Deja una nota visible dentro de la carpeta cuando no hay XML/PDF/CDR o
 * cuando hubo errores, para que no parezca que la consulta "se perdió".
 */
function writeJobReadme(job, stats) {
  if (!job.outputDir) return;

  const lines = [];

  if (stats.soloListar) {
    lines.push("Esta consulta se ejecutó en modo \"Solo listar (sin XML)\".");
    lines.push("Por eso xml/, pdf/ y cdr/ no contienen archivos.");
    lines.push(
      "Vuelve a ejecutar la consulta sin marcar esa opción para descargar los comprobantes.",
    );
  } else if (job.invoices.length > 0 && stats.withFiles === 0) {
    lines.push("No se descargó ningún archivo XML, PDF ni CDR.");
    const firstError = job.invoices.find((record) => record.error)?.error;
    if (firstError) lines.push(`Primer error: ${firstError}`);
    lines.push("Revisa errores.csv o el detalle de la consulta en la aplicación.");
  } else if (stats.errors > 0 || stats.cdrFaltantes > 0) {
    lines.push(
      `Archivos descargados: XML ${stats.xml}, PDF ${stats.pdf}, CDR ${stats.cdr}.`,
    );
    if (stats.errors > 0) {
      lines.push(
        `Comprobantes con error: ${stats.errors}. Revisa errores.csv para el detalle.`,
      );
    }
    if (stats.cdrFaltantes > 0) {
      lines.push(
        `Comprobantes sin CDR: ${stats.cdrFaltantes}. SUNAT no devolvió el CDR de esos comprobantes.`,
      );
    }
  } else {
    return;
  }

  try {
    fs.writeFileSync(
      path.join(job.outputDir, "LEEME.txt"),
      `${lines.join("\n")}\n`,
      "utf8",
    );
  } catch (error) {
    console.error("No se pudo escribir LEEME.txt:", error.message);
  }
}

function writeJobFile(job) {
  if (!job.outputDir) return;

  try {
    ensureDir(job.outputDir);
    writeJson(path.join(job.outputDir, "job.json"), {
      id: job.id,
      status: job.status,
      message: job.message,
      error: job.error,
      total: job.total,
      processed: job.processed,
      cancelled: job.cancelled,
      invoices: job.invoices,
      logs: job.logs.slice(-100),
      options: job.options,
      stats: job.stats || null,
      createdAt: job.createdAt,
      hasOutput: fs.existsSync(path.join(job.outputDir, "comprobantes.csv")),
    });
  } catch (error) {
    console.error("No se pudo guardar el historial:", error.message);
  }
}


module.exports = {
  runJob,
  writeOutputs,
  writeJobReadme,
  writeJobFile,
};
