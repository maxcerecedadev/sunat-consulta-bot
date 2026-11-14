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

function respuestaError(status, body) {
  return {
    ok: () => false,
    status: () => status,
    text: async () => body,
  };
}

test("detecta cuando el emisor es el propio RUC logueado", () => {
  const client = crearCliente();
  assert.equal(
    client.esPropioEmisor({ ruc_emisor: "20613213067" }),
    true,
  );
  assert.equal(
    client.esPropioEmisor({ ruc_emisor: "20-61321306-7" }),
    true,
  );
  assert.equal(
    client.esPropioEmisor({ ruc_emisor: "20123456789" }),
    false,
  );
  assert.equal(client.esPropioEmisor({}), false);
});

test("los emitidos por el propio RUC se bajan por SEE-SOL, no por consultacpe", async () => {
  const client = crearCliente();
  let apiLlamada = false;

  client.descargarCpe = async () => {
    apiLlamada = true;
    return { formato: "xml", content: Buffer.from("api") };
  };
  client.descargarPropio = async (_invoice, formato) => ({
    formato,
    content: Buffer.from("seesol"),
  });

  const result = await client.descargar(
    {
      ruc_emisor: client.ruc,
      tipo: "03",
      serie: "BB01",
      numero: "1906",
      emitido: true,
      cpe: true,
    },
    "xml",
  );

  assert.equal(apiLlamada, false);
  assert.equal(result.content.toString(), "seesol");
});

test("el 422/104 de emisor propio es permanente y no cae a controlcpe", async () => {
  const client = crearCliente();
  let controlcpeLlamado = false;

  client.consultacpeToken = async () => "token";
  client.descargarControlcpe = async () => {
    controlcpeLlamado = true;
    throw new Error("no debería llamarse");
  };
  client.ensureActive = () => ({
    request: {
      get: async () =>
        respuestaError(
          422,
          JSON.stringify({
            cod: "422",
            msg: "Unprocessable Entity",
            errors: [
              {
                codError: "104",
                desError: "El RUC del emisor debe ser diferente al RUC logueado",
              },
            ],
          }),
        ),
    },
  });

  await assert.rejects(
    client.descargarConsultacpe(
      {
        ruc_emisor: "20613213067",
        tipo: "03",
        serie: "BB01",
        numero: "1906",
        emitido: true,
      },
      "/02",
    ),
    (error) => {
      assert.equal(error.permanent, true);
      assert.equal(error.emisorPropio, true);
      assert.match(error.message, /diferente al RUC logueado/);
      return true;
    },
  );
  assert.equal(controlcpeLlamado, false);
});

test("descargarPropio reutiliza el ZIP para XML y CDR", async () => {
  const client = crearCliente();
  let descargas = 0;

  client.ensureModuloPropio = async () => undefined;
  client.downloadZip = async () => {
    descargas += 1;
    return Buffer.from("zip");
  };
  client.extractFromZip = () => ({
    xml: "<xml/>",
    xmlName: "20613213067-03-BB01-1906.xml",
    cdr: "<cdr/>",
    cdrName: "R-20613213067-03-BB01-1906.xml",
  });

  const invoice = { ruc_emisor: client.ruc, tipo: "03", serie: "BB01", numero: "1906" };

  const xml = await client.descargarPropio(invoice, "xml");
  const cdr = await client.descargarPropio(invoice, "cdr");

  assert.equal(descargas, 1);
  assert.equal(xml.content.toString(), "<xml/>");
  assert.equal(cdr.content.toString(), "<cdr/>");
});

test("si el módulo SEE-SOL falla, el error es permanente y explica qué hacer", async () => {
  const client = crearCliente();

  client.ensureModuloPropio = async () => undefined;
  client.downloadZip = async () => {
    throw new Error("SUNAT devolvió una página sin el comprobante.");
  };

  await assert.rejects(
    client.descargarPropio(
      { ruc_emisor: client.ruc, tipo: "03", serie: "BB01", numero: "1906" },
      "xml",
    ),
    (error) => {
      assert.equal(error.permanent, true);
      assert.match(error.message, /SEE-SOL/);
      return true;
    },
  );
});

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
