"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeTipoCpe,
  tipoCpeVariants,
  filtrosCpe,
  buildCpeComprobanteId,
  buildCpeDescargaUrl,
  esBoleta,
} = require("../src/cpe-ids");

const BASE = "https://api-cpe.sunat.gob.pe/v1/contribuyente/consultacpe/comprobantes";

test("normaliza el tipo de comprobante a dos dígitos", () => {
  assert.equal(normalizeTipoCpe("3"), "03");
  assert.equal(normalizeTipoCpe("03"), "03");
  assert.equal(normalizeTipoCpe(7), "07");
  assert.equal(normalizeTipoCpe(" 8 "), "08");
  assert.equal(normalizeTipoCpe("R1"), "R1");
  assert.equal(normalizeTipoCpe(""), "");
  assert.equal(normalizeTipoCpe(null), "");
});

test("prueba primero la variante normalizada y evita duplicados", () => {
  assert.deepEqual(tipoCpeVariants("3"), ["03", "3"]);
  assert.deepEqual(tipoCpeVariants("03"), ["03"]);
  assert.deepEqual(tipoCpeVariants("7"), ["07", "7"]);
});

test("prioriza el filtro del rol correcto", () => {
  assert.deepEqual(filtrosCpe(true), ["1", "2"]);
  assert.deepEqual(filtrosCpe(false), ["2", "1"]);
});

test("construye el identificador del comprobante sin rol vacío", () => {
  assert.equal(
    buildCpeComprobanteId({
      ruc: "20613213067",
      tipo: "3",
      serie: "BB01",
      numero: "1908",
      filtro: "1",
    }),
    "20613213067-03-BB01-1908-1",
  );

  assert.equal(
    buildCpeComprobanteId({
      ruc: "20613213067",
      tipo: "03",
      serie: "BB01",
      numero: "1908",
      filtro: "",
    }),
    "20613213067-03-BB01-1908",
  );
});

test("construye la URL de descarga con el formato correcto", () => {
  assert.equal(
    buildCpeDescargaUrl({
      baseUrl: BASE,
      ruc: "20613213067",
      tipo: "3",
      serie: "BB01",
      numero: "1908",
      filtro: "1",
      formato: "02",
    }),
    `${BASE}/20613213067-03-BB01-1908-1/02`,
  );
});

test("reconoce boletas", () => {
  assert.equal(esBoleta("3"), true);
  assert.equal(esBoleta("03"), true);
  assert.equal(esBoleta("01"), false);
  assert.equal(esBoleta("07"), false);
});
