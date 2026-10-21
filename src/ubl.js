"use strict";

const { XMLParser } = require("fast-xml-parser");

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "object") {
    if (value["#text"] !== undefined) return String(value["#text"]);
    return null;
  }
  return String(value);
}

function num(value) {
  const raw = text(value);
  if (raw === null || raw === "") return 0;
  const parsed = Number(String(raw).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : 0;
}

function attrOf(value, name) {
  if (value && typeof value === "object") {
    return value[`@_${name}`] ?? value[name] ?? null;
  }
  return null;
}

function schemeId(taxSubtotal) {
  return text(taxSubtotal?.TaxCategory?.TaxScheme?.ID) || "";
}

function schemeName(taxSubtotal) {
  return text(taxSubtotal?.TaxCategory?.TaxScheme?.Name) || "";
}

function taxAmount(taxTotal, wanted) {
  const subtotals = asArray(taxTotal).flatMap((total) => asArray(total?.TaxSubtotal));
  let found = 0;
  let hasMatch = false;
  for (const sub of subtotals) {
    const id = schemeId(sub).toUpperCase();
    const name = schemeName(sub).toUpperCase();
    if (
      !wanted ||
      id === wanted ||
      id.includes(wanted) ||
      name === wanted ||
      name.includes(wanted)
    ) {
      found += num(sub.TaxAmount);
      hasMatch = true;
    }
  }
  if (hasMatch) return found;
  const totals = asArray(taxTotal);
  return totals.reduce((acc, total) => acc + num(total?.TaxAmount), 0);
}

function party(partyNode) {
  const party = partyNode?.Party || {};
  const identification = asArray(party.PartyIdentification)[0] || {};
  const legal = asArray(party.PartyLegalEntity)[0] || {};
  const docType = text(identification.ID?.["@_schemeID"]) || text(identification.ID?.["@_schemeId"]) || null;
  return {
    doc_type: docType,
    doc_number: text(identification.ID),
    name: text(legal.RegistrationName) || text(party.PartyName?.Name) || null,
  };
}

function lineItems(lines, quantityKeys) {
  return asArray(lines).map((line, index) => {
    const item = line.Item || {};
    const quantityNode = quantityKeys.map((key) => line[key]).find((value) => value !== undefined);
    const quantity = num(quantityNode);
    const unit = attrOf(quantityNode, "unitCode");
    const price = line.Price || {};
    const lineTotal = num(line.LineExtensionAmount);
    const igv = taxAmount(line.TaxTotal, "IGV");
    return {
      line: text(line.ID) || String(index + 1),
      code: text(item.ID) || text(item.SellersItemIdentification?.ID) || null,
      description: text(item.Description) || null,
      quantity,
      unit: unit || null,
      unit_value: num(price.PriceAmount),
      line_total: lineTotal,
      igv,
    };
  });
}

/**
 * Convierte el XML UBL 2.1 de un comprobante en un objeto normalizado.
 */
function parseUbl(xml) {
  const parsed = parser.parse(xml);
  const doc =
    parsed.Invoice ||
    parsed.CreditNote ||
    parsed.DebitNote ||
    parsed.ApplicationResponse ||
    null;

  if (!doc) {
    throw new Error("El XML no tiene una raíz UBL reconocida (Invoice/CreditNote/DebitNote).");
  }

  const isInvoice = Boolean(parsed.Invoice);
  const isCredit = Boolean(parsed.CreditNote);
  const isDebit = Boolean(parsed.DebitNote);

  const supplier = party(doc.AccountingSupplierParty);
  const customer = party(doc.AccountingCustomerParty);
  const monetary = doc.LegalMonetaryTotal || {};
  const lines = isInvoice
    ? doc.InvoiceLine
    : isCredit
      ? doc.CreditNoteLine
      : doc.DebitNoteLine;
  const quantityKeys = isInvoice
    ? ["InvoicedQuantity"]
    : isCredit
      ? ["CreditedQuantity"]
      : ["DebitedQuantity"];

  const igv = taxAmount(doc.TaxTotal, "IGV");
  const total = num(monetary.PayableAmount) || num(monetary.TaxInclusiveAmount);
  const gravado =
    num(monetary.LineExtensionAmount) ||
    num(monetary.TaxExclusiveAmount) ||
    Math.max(total - igv, 0);

  return {
    tipo: text(doc.InvoiceTypeCode) || (isInvoice ? "01" : isCredit ? "07" : "08"),
    serie: text(doc.ID)?.split("-")[0] || null,
    numero: text(doc.ID)?.split("-").slice(1).join("-") || null,
    fecha: text(doc.IssueDate) || null,
    hora: text(doc.IssueTime) || null,
    moneda: text(doc.DocumentCurrencyCode) || null,
    emisor: supplier,
    cliente: customer,
    totals: {
      gravado,
      igv,
      total,
      descuentos: num(monetary.AllowanceTotalAmount),
      otros_cargos: num(monetary.ChargeTotalAmount),
    },
    items: lineItems(lines, quantityKeys),
  };
}

module.exports = { parseUbl };
