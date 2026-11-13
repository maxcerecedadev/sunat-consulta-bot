"use strict";

const fs = require("fs");
const { TIPOS, TIPO_LABELS, DOCUMENTOS, tipoLabel } = require("../cpe-types");

const CONSULTA_URL =
  process.env.SUNAT_CONSULTA_URL ||
  "https://ww1.sunat.gob.pe/ol-ti-itconscpemype/consultar.do";
const CONSULTA_REFERER =
  process.env.SUNAT_CONSULTA_REFERER || CONSULTA_URL;
const MENU_URLS = [
  process.env.SUNAT_MENU_URL ||
    "https://e-menu.sunat.gob.pe/cl-ti-itmenu/MenuInternet.htm",
  "https://e-menu.sunat.gob.pe/cl-ti-itmenucabina/MenuInternet.htm",
];
const STATE_TTL_MS = Number(process.env.SUNAT_STATE_TTL_MS || 10 * 60 * 1000);
const SIRE_API = "https://api-sire.sunat.gob.pe/v1/contribuyente/migeigv/libros";
const CONSULTACPE_API =
  "https://api-cpe.sunat.gob.pe/v1/contribuyente/consultacpe/comprobantes";
const CONTROLCPE_API =
  "https://api-cpe.sunat.gob.pe/v1/contribuyente/controlcpe";
const BUZON_BASE =
  process.env.SUNAT_BUZON_URL || "https://ww1.sunat.gob.pe/ol-ti-itvisornoti/visor";
const BUZON_MENU_URL =
  process.env.SUNAT_BUZON_MENU_URL ||
  "https://e-menu.sunat.gob.pe/cl-ti-itmenu/MenuInternet.htm?action=buzon&s=ww1";
const BUZON_DETAIL_ROUTE = "**/ol-ti-itvisornoti/visor/obtenerDetalleNoti*";
const TIPOS_RECIBIDOS = new Set(["11", "14", "16"]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// SUNAT responde con codeError != 0 cuando no hay resultados (por ejemplo en
// "Facturas recibidas" si el periodo no tiene comprobantes). No es un fallo de
// la consulta: el listado simplemente está vacío.
const SIN_RESULTADOS_RE =
  /no\s+(?:se\s+)?(?:encontr|existen|hay|existe)|sin\s+(?:resultados|registros|comprobantes|informaci[oó]n)|no\s+existen\s+(?:registros|comprobantes|documentos|informaci[oó]n)/i;

function decodeEntities(value) {
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function toNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(String(value).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function sunatToIsoDate(value) {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(value || "").trim());
  if (!match) return String(value || "").trim();
  return `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
}

function isMissingSireFile(text) {
  return /2244|El archivo solicitado no existe/i.test(String(text || ""));
}

function isoToSunatDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || "").trim());
  if (!match) return String(value || "").trim();
  return `${match[3]}/${match[2]}/${match[1]}`;
}

function freshState(statePath) {
  if (!statePath || !fs.existsSync(statePath)) return false;
  try {
    return Date.now() - fs.statSync(statePath).mtimeMs < STATE_TTL_MS;
  } catch {
    return false;
  }
}

function menuTextRegex(label) {
  const words = String(label)
    .replace(/\s*[-–]\s*/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) =>
      word
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/[áÁ]/g, "[áa]")
        .replace(/[éÉ]/g, "[ée]")
        .replace(/[íÍ]/g, "[íi]")
        .replace(/[óÓ]/g, "[óo]")
        .replace(/[úÚ]/g, "[úu]")
        .replace(/[ñÑ]/g, "[ñn]"),
    );

  return new RegExp(words.join("\\s*[-–]?\\s*"), "i");
}

function normalizeInvoice(raw) {
  const map = {};
  Object.entries(raw || {}).forEach(([key, value]) => {
    map[String(key).toLowerCase()] = value;
  });

  const pick = (...keys) => {
    for (const key of keys) {
      const value = map[key.toLowerCase()];
      if (value !== undefined && value !== null && value !== "") return value;
    }
    return null;
  };

  const tipo = String(
    pick("codFactura", "codTipoComprobante", "tipoComprobante", "codTipoCpe") || "",
  ).trim();
  const serie = String(pick("nroSerie", "numSerie", "serie") || "").trim();
  const numero = String(
    pick("nroFactura", "numComprobante", "numero", "nroDocumento") || "",
  ).trim();

  return {
    id: [tipo, serie, numero, pick("nroRucEmisor", "numRucEmisor", "rucEmisor")].join("|"),
    tipo,
    tipo_label: String(
      pick("desTipoComprobante", "descripcionTipo", "tipoComprobanteDesc") ||
        TIPO_LABELS[tipo] ||
        tipo ||
        "Comprobante",
    ),
    serie,
    numero,
    numero_desc: String(
      pick("nroFacturaDesc", "numeroDesc", "descComprobante") ||
        (serie && numero ? `${serie}-${numero}` : numero),
    ),
    fecha: String(pick("fechaEmisionDesc", "fecEmision", "fechaEmision") || ""),
    ruc_emisor: String(pick("nroRucEmisor", "numRucEmisor", "rucEmisor") || ""),
    emisor: String(
      pick("razonSocialEmisor", "nomRazonSocialEmisor", "desEmisor", "nombreEmisor") || "",
    ),
    ruc_receptor: String(
      pick("nroRucReceptor", "numRucReceptor", "rucReceptor", "nroDocReceptor") || "",
    ),
    receptor: String(
      pick("razonSocialReceptor", "nomRazonSocialReceptor", "desReceptor", "nombreReceptor") || "",
    ),
    total: toNumber(pick("importeTotal", "mtoTotal", "total", "importe", "mtoImporteTotal")),
    moneda: String(pick("codMoneda", "moneda", "tipMoneda") || ""),
    estado: String(pick("desEstado", "estado", "descripcionEstado") || ""),
    raw,
  };
}


module.exports = {
  CONSULTA_URL,
  CONSULTA_REFERER,
  MENU_URLS,
  STATE_TTL_MS,
  SIRE_API,
  CONSULTACPE_API,
  CONTROLCPE_API,
  BUZON_BASE,
  BUZON_MENU_URL,
  BUZON_DETAIL_ROUTE,
  TIPOS_RECIBIDOS,
  sleep,
  SIN_RESULTADOS_RE,
  decodeEntities,
  toNumber,
  sunatToIsoDate,
  isMissingSireFile,
  isoToSunatDate,
  freshState,
  menuTextRegex,
  normalizeInvoice,
  TIPOS,
  TIPO_LABELS,
  DOCUMENTOS,
  tipoLabel,
};
