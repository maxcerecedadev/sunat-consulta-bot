"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isBrowserClosedError,
  sunatDate,
} = require("../src/server/helpers");

test("detecta cuando el navegador se cerró", () => {
  assert.equal(
    isBrowserClosedError(new Error("Target page, context or browser has been closed")),
    true,
  );
  assert.equal(
    isBrowserClosedError(new Error("Consulta cancelada: la sesión de SUNAT ya está cerrada.")),
    true,
  );
  assert.equal(isBrowserClosedError(new Error("SUNAT respondió 500")), false);
  assert.equal(isBrowserClosedError(null), false);
});

test("convierte fechas ISO al formato de SUNAT", () => {
  assert.equal(sunatDate("2026-11-12"), "12/11/2026");
  assert.equal(sunatDate("12/11/2026"), "12/11/2026");
  assert.equal(sunatDate(""), "");
});
