"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { spaFallback } = require("../src/server/routes-fallback");

function crearRespuesta() {
  const respuesta = {
    statusCode: 200,
    sent: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.sent = body;
      return this;
    },
    sendFile(file) {
      this.sent = file;
      return this;
    },
  };
  return respuesta;
}

test("no lanza ReferenceError al servir la SPA", () => {
  const res = crearRespuesta();

  assert.doesNotThrow(() => {
    spaFallback({ path: "/comprobantes" }, res, () => {
      throw new Error("no debería llamar next para una ruta de la SPA");
    });
  });

  assert.ok(res.statusCode === 200 || res.statusCode === 503);
  assert.ok(res.sent);
});

test("deja pasar las rutas de la API", () => {
  let llamado = false;

  spaFallback({ path: "/api/jobs/1" }, crearRespuesta(), () => {
    llamado = true;
  });

  assert.equal(llamado, true);
});
