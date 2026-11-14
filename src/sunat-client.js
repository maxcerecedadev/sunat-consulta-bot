"use strict";

const path = require("path");
const {
  CONSULTA_URL,
  CONSULTA_REFERER,
} = require("./sunat/common");
const { TIPOS, TIPO_LABELS, DOCUMENTOS, tipoLabel } = require("./cpe-types");

class SunatClient {
  constructor(options = {}) {
    this.ruc = String(options.ruc || "").trim();
    this.solUser = String(options.solUser || "").trim();
    this.solPassword = String(options.solPassword || "");
    this.documento = options.documento === "boleta" ? "boleta" : "factura";
    this.sire = Boolean(options.sire);
    this.buzon = Boolean(options.buzon);
    this.menuTokens = {};
    this.buzonFrame = null;
    this.buzonDetailRouteHandler = null;
    this.allowBuzonDetail = false;
    this.cpeDownloadPattern = null;
    this.propioModuloListo = false;
    this.propioFiles = null;
    this.lastBuzonRequestAt = 0;
    this.headless = options.headless !== false;
    this.consultaUrl = CONSULTA_URL;
    this.consultaReferer = CONSULTA_REFERER;
    this.statePath =
      options.statePath || path.join(process.cwd(), ".session", `${this.ruc}.json`);
    this.dataDir =
      options.dataDir || process.env.SUNAT_DATA_DIR || process.cwd();
    this.sireCacheDir =
      options.sireCacheDir ||
      process.env.SUNAT_SIRE_CACHE_DIR ||
      path.join(this.dataDir, ".cache", "sire");
    this.log = options.log || ((message) => process.stderr.write(`${message}\n`));
    this.browser = null;
    this.context = null;
    this.page = null;
    this.closed = false;
  }
}

Object.assign(
  SunatClient.prototype,
  require("./sunat/session"),
  require("./sunat/menu"),
  require("./sunat/module-nav"),
  require("./sunat/tokens"),
  require("./sunat/buzon"),
  require("./sunat/sire"),
  require("./sunat/sire-download"),
  require("./sunat/cpe"),
  require("./sunat/downloads"),
  require("./sunat/invoices"),
);

module.exports = {
  SunatClient,
  TIPOS,
  TIPO_LABELS,
  DOCUMENTOS,
  TIPOS_RECIBIDOS: require("./sunat/common").TIPOS_RECIBIDOS,
  tipoLabel,
  normalizeInvoice: require("./sunat/common").normalizeInvoice,
};
