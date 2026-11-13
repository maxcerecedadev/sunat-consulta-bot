"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseSireComprasTxt,
  parseSireVentasTxt,
  expandirNumeros,
  sireValue,
  toSireNumber,
} = require("../src/sire-parser");

const VENTAS_TXT = [
  "Tipo CP/Doc.|Serie del CDP|Nro CP o Doc. Nro Inicial (Rango)|Nro Final (Rango)|Fecha de emisión|Est. Comp.|Total CP|Moneda|Nro Doc Identidad|Apellidos Nombres/ Razón Social",
  "03|BB01|1906|1908|15/11/2026|1|100.00|PEN||",
  "03|B001|19||15/11/2026|1|50.00|PEN|12345678|CLIENTE UNO",
].join("\n");

const COMPRAS_TXT = [
  "Tipo CP/Doc.|Nro Doc Identidad|Serie del CDP|Nro CP o Doc. Nro Inicial (Rango)|Fecha de emisión|Est. Comp.|Total CP|Moneda|RUC|Apellidos Nombres/ Razón Social",
  "01|20123456789|F001|123|10/11/2026|1|236.00|PEN|20613213067|PROVEEDOR SAC",
  "07|20123456789|F001|124|10/11/2026|3|118.00|PEN|20613213067|PROVEEDOR SAC",
].join("\n");

test("expande rangos de correlativos", () => {
  assert.deepEqual(expandirNumeros("1906-1908", ""), ["1906", "1907", "1908"]);
  assert.deepEqual(expandirNumeros("19", "20"), ["19", "20"]);
  assert.deepEqual(expandirNumeros("19", ""), ["19"]);
  assert.deepEqual(expandirNumeros("A-1", ""), ["A-1"]);
});

test("tolera BOM en el TXT de SIRE", () => {
  const conBom = `\uFEFF${VENTAS_TXT}`;
  const invoices = parseSireVentasTxt(conBom, { docType: "03", ruc: "20613213067" });
  assert.equal(invoices.length, 4);
});

test("parsea la propuesta de ventas y expande rangos", () => {
  const invoices = parseSireVentasTxt(VENTAS_TXT, {
    docType: "03",
    ruc: "20613213067",
  });

  assert.equal(invoices.length, 4);
  assert.deepEqual(
    invoices.slice(0, 3).map((invoice) => invoice.numero),
    ["1906", "1907", "1908"],
  );

  const rango = invoices[0];
  assert.equal(rango.id, "03|BB01|1906|20613213067");
  assert.equal(rango.tipo_label, "Boleta");
  assert.equal(rango.ruc_emisor, "20613213067");
  assert.equal(rango.estado, "Aceptado");
  assert.equal(rango.emitido, true);
  assert.equal(rango.cpe, true);
  assert.equal(rango.total, null);
  assert.equal(rango.ruc_receptor, "");

  const individual = invoices[3];
  assert.equal(individual.numero, "19");
  assert.equal(individual.total, 50);
  assert.equal(individual.ruc_receptor, "12345678");
  assert.equal(individual.receptor, "CLIENTE UNO");
});

test("parsea la propuesta de compras", () => {
  const invoices = parseSireComprasTxt(COMPRAS_TXT, {
    docType: "01",
    ruc: "20613213067",
  });

  assert.equal(invoices.length, 1);
  const factura = invoices[0];
  assert.equal(factura.id, "01|F001|123|20123456789");
  assert.equal(factura.tipo_label, "Factura");
  assert.equal(factura.emisor, "PROVEEDOR SAC");
  assert.equal(factura.ruc_receptor, "20613213067");
  assert.equal(factura.total, 236);
  assert.equal(factura.sire, true);
});

test("mapea los estados de SIRE", () => {
  const anulada = parseSireComprasTxt(COMPRAS_TXT, {
    docType: "07",
    ruc: "20613213067",
  });
  assert.equal(anulada[0].estado, "Anulado");
});

test("helpers de SIRE conservan el comportamiento", () => {
  assert.equal(sireValue({ "Tipo CP/Doc.": "03" }, "Tipo CP/Doc."), "03");
  assert.equal(sireValue({ "Tipo CP/Doc.": "03" }, "Tipo CP/Doc"), "");
  assert.equal(sireValue({ "Fecha de emisión": "15/11/2026" }, "Fecha de emision"), "15/11/2026");
  assert.equal(toSireNumber("1,234.50"), 1234.5);
  assert.equal(toSireNumber(""), 0);
});
