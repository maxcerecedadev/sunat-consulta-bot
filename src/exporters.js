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
  buildRows,
  VOUCHER_COLUMNS,
  ITEM_COLUMNS,
};
