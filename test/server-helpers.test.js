"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isBrowserClosedError,
  normalizeHistoryEntry,
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

test("una consulta en curso en disco se marca como interrumpida, no como error", () => {
  const entry = normalizeHistoryEntry({
    status: "queued",
    message: "En cola...",
    total: 0,
    processed: 0,
  });

  assert.equal(entry.status, "interrupted");
  assert.match(entry.message, /se cerró o reinició/);
  assert.equal(entry.error, "");
});

test("las consultas terminadas conservan su estado", () => {
  for (const status of ["done", "error", "cancelled", "interrupted"]) {
    assert.equal(normalizeHistoryEntry({ status }).status, status);
  }

  const done = normalizeHistoryEntry({ status: "done", message: "ok" });
  assert.equal(done.message, "ok");
});
