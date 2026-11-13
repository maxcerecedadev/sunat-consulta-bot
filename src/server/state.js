"use strict";

require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { exec, execFile } = require("child_process");
const { ZipArchive } = require("archiver");
const {
  SunatClient,
  TIPOS,
  TIPO_LABELS,
  DOCUMENTOS,
  TIPOS_RECIBIDOS,
  tipoLabel,
} = require("../sunat-client");
const { parseUbl } = require("../ubl");
const { parseDate } = require("../dates");
const { ensureDir, safeName, sleep } = require("../util");
const {
  readEmpresas,
  getEmpresa,
  createEmpresa,
  updateEmpresa,
  deleteEmpresa,
} = require("../empresas");
const {
  checkAll,
  checkEmpresa,
  getPreparedItems,
  decorateItems,
  sendPrepared,
  attachmentFile,
} = require("../buzon-service");
const { readAllState, markSent } = require("../buzon-store");
const { whatsapp } = require("../whatsapp-baileys");
const {
  writeJson,
  writeCsv,
  summarizeJob,
  buildRows,
  VOUCHER_COLUMNS,
  ITEM_COLUMNS,
} = require("../exporters");


const app = express();
const PORT = Number(process.env.UI_PORT || 3131);
const HOST = "127.0.0.1";
const DATA_DIR = process.env.SUNAT_DATA_DIR || process.cwd();
const UI_DIR =
  process.env.SUNAT_UI_DIR || path.join(__dirname, "..", "..", "ui-dist");
const OUTPUT_ROOT = path.join(DATA_DIR, "output", "ui");

app.use(express.json({ limit: "1mb" }));
app.use(express.static(UI_DIR));

const jobs = new Map();
const clients = new Map();
const buzonJobs = new Map();

module.exports = {
  app,
  PORT,
  HOST,
  DATA_DIR,
  UI_DIR,
  OUTPUT_ROOT,
  jobs,
  clients,
  buzonJobs,
};
