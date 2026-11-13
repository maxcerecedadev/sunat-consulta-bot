"use strict";

/**
 * Helpers puros para construir identificadores de comprobantes SUNAT.
 *
 * El API `consultacpe` usa el formato:
 *   {RUC}-{TIPO}-{SERIE}-{NUMERO}-{FILTRO}/{FORMATO}
 *
 * - TIPO: catálogo SUNAT N° 01, siempre con 2 dígitos ("03" = boleta).
 * - FILTRO: 1 = emisor, 2 = receptor.
 * - FORMATO: "01" PDF, "02" XML, "03" CDR.
 */

const CPE_TIPO_BOLETA = "03";
const FORMATOS_CPE = {
  pdf: "01",
  xml: "02",
  cdr: "03",
};

function normalizeTipoCpe(tipo) {
  const raw = String(tipo === undefined || tipo === null ? "" : tipo).trim();
  if (!raw) return "";
  return /^\d+$/.test(raw) ? raw.padStart(2, "0") : raw;
}

/** Devuelve las variantes a probar: primero normalizada, luego la original. */
function tipoCpeVariants(tipo) {
  const raw = String(tipo === undefined || tipo === null ? "" : tipo).trim();
  const normalized = normalizeTipoCpe(raw);
  return [normalized, raw].filter(
    (value, index, values) => value && values.indexOf(value) === index,
  );
}

function filtroCpe(emitido) {
  return emitido ? "1" : "2";
}

/** Filtros a probar, priorizando el rol correcto del comprobante. */
function filtrosCpe(emitido) {
  return emitido ? ["1", "2"] : ["2", "1"];
}

function buildCpeComprobanteId({ ruc, tipo, serie, numero, filtro }) {
  const base = `${ruc}-${normalizeTipoCpe(tipo)}-${serie}-${numero}`;
  return filtro ? `${base}-${filtro}` : base;
}

function buildCpeDescargaUrl({ baseUrl, ruc, tipo, serie, numero, filtro, formato }) {
  return `${baseUrl}/${buildCpeComprobanteId({
    ruc,
    tipo,
    serie,
    numero,
    filtro,
  })}/${formato}`;
}

function esBoleta(tipo) {
  return normalizeTipoCpe(tipo) === CPE_TIPO_BOLETA;
}

module.exports = {
  CPE_TIPO_BOLETA,
  FORMATOS_CPE,
  normalizeTipoCpe,
  tipoCpeVariants,
  filtroCpe,
  filtrosCpe,
  buildCpeComprobanteId,
  buildCpeDescargaUrl,
  esBoleta,
};
