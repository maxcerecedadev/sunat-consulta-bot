"use strict";

const fs = require("fs");

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function escapeCsv(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (/[",\n\r;]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function writeCsv(file, rows, columns) {
  const lines = [columns.join(",")];
  for (const row of rows) {
    lines.push(columns.map((column) => escapeCsv(row[column])).join(","));
  }
  fs.writeFileSync(file, `\uFEFF${lines.join("\r\n")}`, "utf8");
}

/**
 * Resume cuántos archivos se descargaron realmente y cuántos comprobantes
 * quedaron con error. Sirve para que el historial no muestre "Completada"
 * cuando en realidad no se guardó ningún XML/PDF/CDR.
 */
function summarizeJob(job, options = {}) {
  const invoices = Array.isArray(job?.invoices) ? job.invoices : [];
  const soloListar = Boolean(job?.options?.soloListar);
  // En facturas emitidas el CDR solo viene si está dentro del ZIP; no se
  // intenta por separado. Solo se reporta como faltante cuando el flujo sí lo
  // busca (boletas emitidas y comprobantes recibidos).
  const intentaCdr = Boolean(job?.options?.cpe || job?.options?.sire);
  const fileExists =
    typeof options.fileExists === "function" ? options.fileExists : null;
  const hasFile = (value) =>
    Boolean(value) && (!fileExists || fileExists(String(value)));
  const stats = {
    soloListar,
    total: invoices.length,
    withFiles: 0,
    xml: 0,
    pdf: 0,
    cdr: 0,
    files: 0,
    errors: 0,
    sinArchivos: 0,
    cdrFaltantes: 0,
  };

  for (const invoice of invoices) {
    const files = invoice?.files || {};
    const xml = hasFile(files.xml);
    const pdf = hasFile(files.pdf);
    const cdr = hasFile(files.cdr);
    const count = (xml ? 1 : 0) + (pdf ? 1 : 0) + (cdr ? 1 : 0);

    if (xml) stats.xml += 1;
    if (pdf) stats.pdf += 1;
    if (cdr) stats.cdr += 1;
    stats.files += count;

    if (count > 0) {
      stats.withFiles += 1;
    } else if (!soloListar) {
      stats.sinArchivos += 1;
    }

    if (invoice?.error) stats.errors += 1;
    if (!cdr && !soloListar && intentaCdr) stats.cdrFaltantes += 1;
  }

  return stats;
}

/**
 * Convierte el resultado de la corrida en filas planas para CSV.
 */
function buildRows(results) {
  const vouchers = [];
  const items = [];

  for (const result of results) {
    const invoice = result.invoice;
    const detail = result.detail;

    vouchers.push({
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
      moneda: invoice.moneda,
      total: invoice.total,
      estado: invoice.estado,
      items_count: detail?.items?.length ?? "",
      xml: result.xmlFile || "",
      pdf: result.pdfFile || "",
      cdr: result.cdrFile || "",
      error: result.error || "",
    });

    for (const item of detail?.items || []) {
      items.push({
        serie: invoice.serie,
        numero: invoice.numero,
        tipo: invoice.tipo,
        linea: item.line,
        codigo: item.code,
        descripcion: item.description,
        cantidad: item.quantity,
        unidad: item.unit,
        valor_unitario: item.unit_value,
        total_linea: item.line_total,
        igv: item.igv,
      });
    }
  }

  return { vouchers, items };
}

const VOUCHER_COLUMNS = [
  "tipo",
  "tipo_label",
  "serie",
  "numero",
  "numero_desc",
  "fecha",
  "ruc_emisor",
  "emisor",
  "ruc_receptor",
  "receptor",
  "moneda",
  "total",
  "estado",
  "items_count",
  "xml",
  "pdf",
  "cdr",
  "error",
];

const ITEM_COLUMNS = [
  "serie",
  "numero",
  "tipo",
  "linea",
  "codigo",
  "descripcion",
  "cantidad",
  "unidad",
  "valor_unitario",
  "total_linea",
  "igv",
];

module.exports = {
  writeJson,
  writeCsv,
  summarizeJob,
  buildRows,
  VOUCHER_COLUMNS,
  ITEM_COLUMNS,
};
