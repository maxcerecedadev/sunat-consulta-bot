"use strict";

const { TIPO_LABELS } = require("./cpe-types");

function normalizeKey(value) {
  return String(value === undefined || value === null ? "" : value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function sireValue(row, ...names) {
  const entries = Object.entries(row || {});
  for (const name of names) {
    const wanted = normalizeKey(name);
    const match = entries.find(([key]) => normalizeKey(key) === wanted);
    if (match && String(match[1]).trim() !== "") return String(match[1]).trim();
  }
  return "";
}

function toSireNumber(value) {
  const parsed = Number(String(value || "").replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function estadoFromSire(raw) {
  if (raw === "1") return "Aceptado";
  if (raw === "0") return "No aceptado";
  if (raw === "2") return "Rechazado";
  if (raw === "3") return "Anulado";
  return raw || "Aceptado";
}

/**
 * Convierte el TXT de propuesta de SIRE en filas indexadas por encabezado.
 * Devuelve [] cuando el archivo no tiene datos.
 */
function parseSireRows(text) {
  const clean = String(text === undefined || text === null ? "" : text).replace(
    /^\uFEFF/,
    "",
  );
  const lines = clean.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length < 2) return [];

  const headers = lines[0].split("|").map((header) => header.trim());
  const rows = [];

  for (const line of lines.slice(1)) {
    const cols = line.split("|");
    const row = {};
    headers.forEach((header, index) => {
      row[header] = cols[index] === undefined ? "" : cols[index];
    });
    rows.push(row);
  }

  return rows;
}

function expandirNumeros(numeroIniRaw, numeroFinRaw) {
  const numeros = [];
  const rango = /^(\d+)\s*-\s*(\d+)$/.exec(numeroIniRaw);

  if (rango) {
    const inicio = Number(rango[1]);
    const fin = Number(rango[2]);
    for (let n = inicio; n <= fin && numeros.length < 5000; n++) {
      numeros.push(String(n));
    }
    return numeros;
  }

  if (/^\d+$/.test(numeroIniRaw)) {
    const inicio = Number(numeroIniRaw);
    if (/^\d+$/.test(numeroFinRaw) && Number(numeroFinRaw) > inicio) {
      const fin = Number(numeroFinRaw);
      for (let n = inicio; n <= fin && numeros.length < 5000; n++) {
        numeros.push(String(n));
      }
    } else {
      numeros.push(String(inicio));
    }
    return numeros;
  }

  numeros.push(numeroIniRaw.trim());
  return numeros;
}

/**
 * Propuesta SIRE RCE (compras). Cada fila es un comprobante recibido.
 */
function parseSireComprasTxt(text, { docType = "", ruc = "" } = {}) {
  const invoices = [];

  for (const row of parseSireRows(text)) {
    const rowType = sireValue(row, "Tipo CP/Doc.", "Tipo CP/Doc");
    if (docType && rowType && rowType !== docType) continue;

    const rucEmisor = sireValue(row, "Nro Doc Identidad");
    const serie = sireValue(row, "Serie del CDP");
    let numero = sireValue(
      row,
      "Nro CP o Doc. Nro Inicial (Rango)",
      "Nro CP o Doc. Nro Inicial",
    );

    if (!rucEmisor || !serie || !numero) continue;
    if (/^\d+$/.test(numero)) numero = String(Number(numero));

    const tipo = rowType || docType;
    const estado = estadoFromSire(
      sireValue(row, "Est. Comp.", "Est. Comprobante", "Estado", "Estado del comprobante"),
    );

    invoices.push({
      id: `${tipo}|${serie}|${numero}|${rucEmisor}`,
      tipo,
      tipo_label: TIPO_LABELS[tipo] || tipo || "Comprobante",
      serie,
      numero,
      numero_desc: `${serie} - ${numero}`,
      fecha: sireValue(row, "Fecha de emisión", "Fecha de emision"),
      ruc_emisor: rucEmisor,
      emisor: sireValue(
        row,
        "Apellidos Nombres/ Razón Social",
        "Apellidos Nombres/ Razon Social",
      ),
      ruc_receptor: sireValue(row, "RUC") || ruc,
      receptor: sireValue(
        row,
        "Apellidos y Nombres o Razón social",
        "Apellidos y Nombres o Razon social",
      ),
      total: toSireNumber(sireValue(row, "Total CP")),
      moneda: sireValue(row, "Moneda"),
      estado,
      sire: true,
      raw: row,
    });
  }

  return invoices;
}

/**
 * Propuesta SIRE RVIE (ventas). Cada fila puede representar un rango de
 * boletas, por lo que se expande a un comprobante por correlativo.
 */
function parseSireVentasTxt(text, { docType = "", ruc = "" } = {}) {
  const invoices = [];

  for (const row of parseSireRows(text)) {
    const rowType = sireValue(row, "Tipo CP/Doc.", "Tipo CP/Doc");
    if (docType && rowType && rowType !== docType) continue;

    const serie = sireValue(row, "Serie del CDP");
    const numeroIniRaw = sireValue(
      row,
      "Nro CP o Doc. Nro Inicial (Rango)",
      "Nro CP o Doc. Nro Inicial",
    );
    const numeroFinRaw = sireValue(
      row,
      "Nro Final (Rango)",
      "Nro CP o Doc. Nro Final",
      "Nro final",
      "Nro Final",
    );

    if (!serie || !numeroIniRaw) continue;

    const tipo = rowType || docType;
    const estado = estadoFromSire(
      sireValue(row, "Est. Comp.", "Est. Comprobante", "Estado", "Estado del comprobante"),
    );
    const fecha = sireValue(
      row,
      "Fecha de emisión",
      "Fecha de emision",
      "Fecha Emisión",
      "Fecha Emision",
      "Fecha de Emisión",
      "Fec. Emisión",
      "Fec Emisión",
      "Fec. Emision",
      "Fec Emision",
      "Fecha",
    );
    const rucReceptor = sireValue(row, "Nro Doc Identidad", "Nro Doc. Identidad");
    const receptor = sireValue(
      row,
      "Apellidos Nombres/ Razón Social",
      "Apellidos Nombres/ Razon Social",
    );
    const total = toSireNumber(sireValue(row, "Total CP"));
    const moneda = sireValue(row, "Moneda");
    const numeros = expandirNumeros(numeroIniRaw, numeroFinRaw);
    const esRango = numeros.length > 1;

    for (const numero of numeros) {
      invoices.push({
        id: `${tipo}|${serie}|${numero}|${ruc}`,
        tipo,
        tipo_label: TIPO_LABELS[tipo] || tipo || "Comprobante",
        serie,
        numero,
        numero_desc: `${serie} - ${numero}`,
        fecha,
        ruc_emisor: ruc,
        emisor: "",
        ruc_receptor: esRango ? "" : rucReceptor,
        receptor: esRango ? "" : receptor,
        total: esRango ? null : total,
        moneda,
        estado,
        emitido: true,
        cpe: true,
        raw: row,
      });
    }
  }

  return invoices;
}

module.exports = {
  normalizeKey,
  sireValue,
  toSireNumber,
  estadoFromSire,
  parseSireRows,
  expandirNumeros,
  parseSireComprasTxt,
  parseSireVentasTxt,
};
