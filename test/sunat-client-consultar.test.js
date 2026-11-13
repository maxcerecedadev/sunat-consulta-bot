"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { SunatClient } = require("../src/sunat-client");

function crearCliente() {
  const client = new SunatClient({
    ruc: "20613213067",
    solUser: "usuario",
    solPassword: "clave",
  });
  client.log = () => undefined;
  client.withRetry = (operation) => operation();
  return client;
}

test("facturas emitidas usa el portal cuando devuelve datos", async () => {
  const client = crearCliente();
  let sireLlamado = false;

  client.consultarPortal = async () => [{ id: "01|F001|1" }];
  client.consultarSireVentas = async () => {
    sireLlamado = true;
    return [];
  };

  const result = await client.consultar({
    desde: "01/11/2026",
    hasta: "30/11/2026",
    tipo: 10,
  });

  assert.equal(result.length, 1);
  assert.equal(sireLlamado, false);
});

test("facturas emitidas cae a SIRE Ventas si el portal devuelve vacío", async () => {
  const client = crearCliente();
  let sireLlamado = false;

  client.consultarPortal = async () => [];
  client.consultarSireVentas = async ({ tipo }) => {
    sireLlamado = tipo === 10;
    return [{ id: "01|F001|1|20613213067" }];
  };

  const result = await client.consultar({
    desde: "01/11/2026",
    hasta: "30/11/2026",
    tipo: 10,
  });

  assert.equal(sireLlamado, true);
  assert.equal(result.length, 1);
});

test("facturas emitidas cae a SIRE Ventas si el portal falla", async () => {
  const client = crearCliente();
  let sireLlamado = false;

  client.consultarPortal = async () => {
    throw new Error("SUNAT no devolvió el listado esperado.");
  };
  client.consultarSireVentas = async () => {
    sireLlamado = true;
    return [];
  };

  await client.consultar({
    desde: "01/11/2026",
    hasta: "30/11/2026",
    tipo: 10,
  });

  assert.equal(sireLlamado, true);
});

test("facturas recibidas siguen usando el portal sin respaldo SIRE Ventas", async () => {
  const client = crearCliente();
  let sireLlamado = false;

  client.consultarPortal = async () => [{ id: "01|F001|1" }];
  client.consultarSireVentas = async () => {
    sireLlamado = true;
    return [];
  };

  await client.consultar({
    desde: "01/11/2026",
    hasta: "30/11/2026",
    tipo: 11,
  });

  assert.equal(sireLlamado, false);
});
