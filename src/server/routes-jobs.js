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


const { app, jobs, clients, buzonJobs, OUTPUT_ROOT } = require("./state");
const { jobStats, loadHistory, openFolder } = require("./helpers");
const { runJob, writeOutputs, writeJobReadme, writeJobFile } = require("./run-job");

app.get("/api/jobs/:id/zip", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || !job.outputDir || !fs.existsSync(job.outputDir)) {
    return res.status(404).json({ error: "Consulta no encontrada." });
  }

  const ruc = job.options?.ruc || "sunat";
  const desde = String(job.options?.desde || "").replace(/-/g, "");
  const hasta = String(job.options?.hasta || "").replace(/-/g, "");
  const filename = `consulta-${ruc}-${desde}-${hasta}.zip`.replace(/[^\w.-]+/g, "_");

  res.attachment(filename);

  const archive = new ZipArchive({ zlib: { level: 9 } });
  archive.on("error", (error) => {
    console.error("Error creando ZIP:", error.message);
    if (!res.headersSent) res.status(500).json({ error: "No se pudo crear el ZIP." });
    else res.destroy(error);
  });

  archive.pipe(res);
  archive.glob("**/*", { cwd: job.outputDir, ignore: ["job.json"] });
  archive.finalize().catch((error) => {
    console.error("Error finalizando ZIP:", error.message);
    res.destroy(error);
  });
});

app.post("/api/jobs/:id/open-folder", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || !job.outputDir) {
    return res.status(404).json({ error: "Consulta no encontrada." });
  }

  const root = path.resolve(OUTPUT_ROOT);
  const dir = path.resolve(job.outputDir);
  const relative = path.relative(root, dir);

  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return res.status(400).json({ error: "Carpeta de la consulta no válida." });
  }

  if (!fs.existsSync(dir)) {
    return res.status(404).json({ error: "La carpeta de la consulta ya no existe." });
  }

  openFolder(dir);
  res.json({ ok: true, path: dir });
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Consulta no encontrada." });

  const stats = jobStats(job);

  res.json({
    id: job.id,
    status: job.status,
    message: job.message,
    error: job.error,
    total: job.total,
    processed: job.processed,
    cancelled: job.cancelled,
    invoices: job.invoices,
    logs: job.logs.slice(-40),
    options: job.options,
    stats,
    hasFiles: stats.files > 0,
    createdAt: job.createdAt,
    hasOutput: fs.existsSync(path.join(job.outputDir, "comprobantes.csv")),
  });
});

app.delete("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Consulta no encontrada." });

  if (["queued", "login", "listing", "processing"].includes(job.status)) {
    return res.status(409).json({
      error: "No se puede eliminar una consulta en curso. Cancélala primero.",
    });
  }

  const client = clients.get(job.id);
  if (client) client.close().catch(() => undefined);
  clients.delete(job.id);
  jobs.delete(job.id);

  if (job.outputDir) {
    const root = path.resolve(OUTPUT_ROOT);
    const dir = path.resolve(job.outputDir);
    const relative = path.relative(root, dir);

    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  res.json({ ok: true });
});

app.post("/api/jobs/:id/cancel", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Consulta no encontrada." });

  job.cancelled = true;
  job.message = "Cancelando...";

  const client = clients.get(job.id);
  if (client) {
    // Cerrar el navegador aborta el login/consulta/descarga en curso.
    client.close().catch(() => undefined);
  }

  setTimeout(() => {
    if (!["done", "error", "cancelled"].includes(job.status)) {
      job.status = "cancelled";
      job.message = "Consulta cancelada.";
      writeOutputs(job);
    }
  }, 3000);

  res.json({ ok: true });
});

app.get("/api/jobs/:id/files/:section/:name", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Consulta no encontrada." });

  const { section } = req.params;
  if (!["xml", "pdf", "cdr"].includes(section)) {
    return res.status(400).json({ error: "Sección no válida." });
  }

  const name = path.basename(req.params.name);
  const file = path.join(job.outputDir, section, name);
  if (!fs.existsSync(file)) return res.status(404).json({ error: "Archivo no encontrado." });

  res.download(file, name);
});

app.get("/api/jobs/:id/export/:name", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Consulta no encontrada." });

  const allowed = ["comprobantes.json", "comprobantes.csv", "items.csv", "errores.csv"];
  const name = path.basename(req.params.name);
  if (!allowed.includes(name)) return res.status(400).json({ error: "Archivo no válido." });

  const file = path.join(job.outputDir, name);
  if (!fs.existsSync(file)) return res.status(404).json({ error: "Archivo no encontrado." });

  res.download(file, name);
});

