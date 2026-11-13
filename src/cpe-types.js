"use strict";

/**
 * Catálogo de tipos de consulta que usa la aplicación (no es el catálogo
 * SUNAT de comprobantes, es la numeración interna del menú de consulta).
 */
const TIPOS = {
  10: "Facturas emitidas",
  11: "Facturas recibidas",
  12: "Facturas rechazadas",
  13: "Notas de crédito emitidas",
  14: "Notas de crédito recibidas",
  15: "Notas de débito emitidas",
  16: "Notas de débito recibidas",
};

/** Catálogo SUNAT N° 01 (solo los tipos que se descargan por comprobante). */
const TIPO_LABELS = {
  "01": "Factura",
  "03": "Boleta",
  "07": "Nota de crédito",
  "08": "Nota de débito",
};

const DOCUMENTOS = {
  factura: "Facturas",
  boleta: "Boletas",
};

/**
 * El código 10-16 es el mismo para el módulo de facturas y el de boletas;
 * solo cambia el módulo que se abre en el menú de SUNAT.
 */
function tipoLabel(tipo, documento = "factura") {
  const label = TIPOS[tipo] || String(tipo);
  return documento === "boleta" ? label.replace(/^Facturas/, "Boletas") : label;
}

/**
 * Tipo de comprobante que espera la propuesta RVIE de SIRE Ventas.
 * Facturas = 01, boletas = 03, notas de crédito = 07, notas de débito = 08.
 */
function sireVentasDocType(tipo, documento = "boleta") {
  const code = String(tipo);
  if (code === "13") return "07";
  if (code === "15") return "08";
  return documento === "boleta" ? "03" : "01";
}

module.exports = {
  TIPOS,
  TIPO_LABELS,
  DOCUMENTOS,
  tipoLabel,
  sireVentasDocType,
};
