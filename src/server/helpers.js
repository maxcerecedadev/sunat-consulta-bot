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


const { OUTPUT_ROOT, jobs } = require("./state");

function openFolder(dir) {
  let child;

  try {
    if (process.platform === "win32") {
      child = execFile("explorer.exe", [dir]);
    } else if (process.platform === "darwin") {
      child = execFile("open", [dir]);
    } else {
      child = execFile("xdg-open", [dir]);
    }
  } catch {
    return;
  }

  // explorer.exe devuelve código 1 aunque la carpeta se abra; el error no es
  // relevante para la UI. Solo se evita que el proceso quede colgado.
  child.on("error", () => undefined);
  child.unref?.();
}

/**
 * Calcula el resumen de la consulta comprobando que los archivos existan
 * realmente en disco. Así el historial no muestra archivos que se borraron
 * o que quedaron registrados en una ruta distinta.
 */
function jobStats(job) {
  const dir = job?.outputDir;
  return summarizeJob(job, {
    fileExists: dir
      ? (relative) => fs.existsSync(path.join(dir, relative))
      : undefined,
  });
}



function sunatDate(value) {
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
    const [year, month, day] = value.slice(0, 10).split("-");
    return `${day}/${month}/${year}`;
  }
  return value;
}

function isBrowserClosedError(error) {
  return /Target page, context or browser has been closed|browser has been closed|Consulta cancelada: la sesión de SUNAT ya está cerrada/i.test(
    String(error && error.message ? error.message : error),
  );
}


const ACTIVE_JOB_STATUSES = ["queued", "login", "listing", "processing"];

/**
 * Una consulta que quedó "en curso" en disco sólo puede venir de una corrida
 * interrumpida (la app se cerró o se reinició). No es un error de SUNAT, así
 * que se marca como interrumpida para no confundirla con una consulta fallida.
 */
function normalizeHistoryEntry(data) {
  if (ACTIVE_JOB_STATUSES.includes(data.status)) {
    data.status = "interrupted";
    data.message =
      "Consulta interrumpida: la aplicación se cerró o reinició antes de terminar.";
    data.error = "";
  } else if (!["done", "error", "cancelled", "interrupted"].includes(data.status)) {
    data.status = "error";
    data.error = data.error || "Consulta interrumpida.";
    data.message = "Consulta interrumpida (el servidor se reinició).";
  }

  return data;
}


function loadHistory() {
  if (!fs.existsSync(OUTPUT_ROOT)) return;

  const entries = [];

  for (const dir of fs.readdirSync(OUTPUT_ROOT, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;

    const file = path.join(OUTPUT_ROOT, dir.name, "job.json");
    if (!fs.existsSync(file)) continue;

    try {
      const data = normalizeHistoryEntry(
        JSON.parse(fs.readFileSync(file, "utf8")),
      );
      if (!data.id) data.id = dir.name;

      data.outputDir = path.join(OUTPUT_ROOT, dir.name);

      data.hasOutput = fs.existsSync(
        path.join(data.outputDir, "comprobantes.csv"),
      );
      entries.push(data);
    } catch (error) {
      console.error(`No se pudo leer el historial ${file}:`, error.message);
    }
  }

  entries
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .slice(0, 500)
    .forEach((entry) => jobs.set(entry.id, entry));
}

/**
 * La UI es una SPA de Vite. Cualquier ruta que no sea /api devuelve index.html.
 */

function openBrowser(url) {
  if (process.env.UI_OPEN === "false") return;

  const command =
    process.platform === "win32"
      ? `start "" "${url}"`
      : process.platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;

  exec(command, () => undefined);
}

loadHistory();


module.exports = {
  openFolder,
  jobStats,
  sunatDate,
  isBrowserClosedError,
  normalizeHistoryEntry,
  loadHistory,
  openBrowser,
};
