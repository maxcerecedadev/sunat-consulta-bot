"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { SunatClient } = require("../src/sunat-client");

function crearCliente() {
  const client = new SunatClient({
    ruc: "20613213067",
    solUser: "usuario",
    solPassword: "clave",
  });
  client.sireCacheDir = "/tmp/sunat-sire-test";
  return client;
}

test("la caché SIRE no depende del rango de fechas elegido", () => {
  const client = crearCliente();

  const uno = client.sireCachePath({
    libro: "ventas",
    periodo: "202610",
    docType: "01",
    fechaIni: "2026-10-01",
    fechaFin: "2026-10-31",
  });
  const dos = client.sireCachePath({
    libro: "ventas",
    periodo: "202610",
    docType: "01",
    fechaIni: "2026-10-15",
    fechaFin: "2026-10-15",
  });

  assert.equal(uno, dos);
  assert.equal(
    path.basename(uno),
    "20613213067-ventas-202610-01.txt.gz",
  );
});

test("periodos cerrados se conservan 24 horas", () => {
  const client = crearCliente();
  assert.equal(client.sireCacheTtlMs("202001"), 24 * 60 * 60 * 1000);
});

test("SUNAT_SIRE_CACHE_TTL_MS permite ajustar la vigencia", () => {
  const client = crearCliente();
  const anterior = process.env.SUNAT_SIRE_CACHE_TTL_MS;
  process.env.SUNAT_SIRE_CACHE_TTL_MS = "7200000";
  try {
    assert.equal(client.sireCacheTtlMs("202001"), 7200000);
  } finally {
    if (anterior === undefined) delete process.env.SUNAT_SIRE_CACHE_TTL_MS;
    else process.env.SUNAT_SIRE_CACHE_TTL_MS = anterior;
  }
});
