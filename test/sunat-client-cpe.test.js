"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { SunatClient } = require("../src/sunat-client");

const BASE = "https://api-cpe.sunat.gob.pe/v1/contribuyente/consultacpe/comprobantes";

function crearCliente() {
  return new SunatClient({
    ruc: "20613213067",
    solUser: "usuario",
    solPassword: "clave",
  });
}

function respuestaOk(valor) {
  return {
    ok: () => true,
    json: async () => ({ valArchivo: Buffer.from(valor).toString("base64") }),
  };
}

test("descarga consultacpe normaliza el tipo y usa el filtro de emisor", async () => {
  const client = crearCliente();
  const urls = [];

  client.consultacpeToken = async () => "token";
  client.ensureActive = () => ({
    request: {
      get: async (url) => {
        urls.push(url);
        return respuestaOk("zip");
      },
    },
  });

  const content = await client.descargarConsultacpe(
    {
      ruc_emisor: "20613213067",
      tipo: "3",
      serie: "BB01",
      numero: "1908",
      emitido: true,
    },
    "/02",
  );

  assert.equal(content.toString(), "zip");
  assert.deepEqual(urls, [`${BASE}/20613213067-03-BB01-1908-1/02`]);
});

test("descarga consultacpe usa el filtro de receptor cuando corresponde", async () => {
  const client = crearCliente();
  const urls = [];

  client.consultacpeToken = async () => "token";
  client.ensureActive = () => ({
    request: {
      get: async (url) => {
        urls.push(url);
        return respuestaOk("zip");
      },
    },
  });

  await client.descargarConsultacpe(
    {
      ruc_emisor: "20123456789",
      tipo: "01",
      serie: "F001",
      numero: "123",
      emitido: false,
    },
    "/03",
  );

  assert.deepEqual(urls, [`${BASE}/20123456789-01-F001-123-2/03`]);
});

test("un 404 de boleta se marca como permanente (no se reintenta)", async () => {
  const client = crearCliente();
  client.descargarConsultacpe = async () => {
    throw new Error('{"status":404,"message":"Resource not found"}');
  };

  await assert.rejects(
    client.descargarCpe(
      {
        ruc_emisor: "20613213067",
        tipo: "3",
        serie: "BB01",
        numero: "1908",
        emitido: true,
        cpe: true,
      },
      "xml",
    ),
    (error) => {
      assert.equal(error.permanent, true);
      assert.match(error.message, /Resumen Diario/);
      return true;
    },
  );
});

test("un 404 de factura no se marca como permanente", async () => {
  const client = crearCliente();
  client.descargarConsultacpe = async () => {
    throw new Error('{"status":404,"message":"Resource not found"}');
  };

  await assert.rejects(
    client.descargarCpe(
      {
        ruc_emisor: "20613213067",
        tipo: "01",
        serie: "F001",
        numero: "123",
        emitido: true,
        cpe: true,
      },
      "xml",
    ),
    (error) => error.permanent !== true,
  );
});
