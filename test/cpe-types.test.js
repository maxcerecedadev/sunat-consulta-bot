"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { TIPOS, TIPO_LABELS, DOCUMENTOS, tipoLabel } = require("../src/cpe-types");

test("mantiene el catálogo de tipos de consulta", () => {
  assert.equal(TIPOS[10], "Facturas emitidas");
  assert.equal(TIPOS[16], "Notas de débito recibidas");
  assert.equal(TIPO_LABELS["03"], "Boleta");
  assert.equal(DOCUMENTOS.boleta, "Boletas");
});

test("adapta la etiqueta al documento consultado", () => {
  assert.equal(tipoLabel(10, "factura"), "Facturas emitidas");
  assert.equal(tipoLabel(10, "boleta"), "Boletas emitidas");
  assert.equal(tipoLabel(13, "boleta"), "Notas de crédito emitidas");
  assert.equal(tipoLabel("99", "factura"), "99");
});
