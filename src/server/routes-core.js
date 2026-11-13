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

app.get("/api/tipos", (_req, res) => {
  res.json(TIPOS);
});

app.get("/api/documentos", (_req, res) => {
  res.json(DOCUMENTOS);
});

app.get("/api/config", (_req, res) => {
  res.json({
    ruc: process.env.SUNAT_RUC || "",
    user: process.env.SUNAT_USER || "",
    headless: process.env.SUNAT_HEADLESS !== "false",
  });
});

app.post("/api/consulta", (req, res) => {
  const body = req.body || {};

  try {
    const ruc = String(body.ruc || "").trim();
    const user = String(body.user || "").trim();
    const password = String(body.password || "");
    const tipo = String(body.tipo || "10");
    const documento = String(body.documento || "factura").toLowerCase();

    if (!/^\d{11}$/.test(ruc)) throw new Error("El RUC debe tener 11 dígitos.");
    if (!user) throw new Error("Ingresa el usuario SOL.");
    if (!password) throw new Error("Ingresa la clave SOL.");
    if (!TIPOS[tipo]) throw new Error("Tipo de consulta no válido.");
    if (!DOCUMENTOS[documento]) throw new Error("Documento no válido.");

    const desde = parseDate(body.desde, "Fecha desde");
    const hasta = parseDate(body.hasta, "Fecha hasta");
    if (desde.iso > hasta.iso) {
      throw new Error("La fecha inicial no puede ser mayor que la final.");
    }

    const sire = TIPOS_RECIBIDOS.has(tipo);
    const cpe = documento === "boleta" && !sire;
    if (sire && desde.iso.slice(0, 7) !== hasta.iso.slice(0, 7)) {
      throw new Error(
        "Para comprobantes recibidos selecciona un solo mes: se consultan desde el SIRE (RCE).",
      );
    }

    const max = body.max ? Number(body.max) : null;
    if (max !== null && (!Number.isFinite(max) || max < 1)) {
      throw new Error("El máximo debe ser un número mayor a cero.");
    }

    const soloListar = Boolean(body.soloListar);
    const options = {
      ruc,
      user,
      desde,
      hasta,
      tipo,
      documento,
      sire,
      cpe,
      soloListar,
      descargarXml: !soloListar && body.descargarXml !== false,
      descargarPdf: !soloListar && body.descargarPdf !== false,
      headless:
        typeof body.visible === "boolean"
          ? !body.visible
          : process.env.SUNAT_HEADLESS !== "false",
      max,
    };

    const id = crypto.randomUUID();
    const outputDir = path.join(
      OUTPUT_ROOT,
      `${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}_${id.slice(0, 8)}`,
    );
    ensureDir(outputDir);
    ensureDir(path.join(outputDir, "xml"));
    ensureDir(path.join(outputDir, "pdf"));
    ensureDir(path.join(outputDir, "cdr"));

    const job = {
      id,
      status: "queued",
      message: "En cola...",
      error: null,
      total: 0,
      processed: 0,
      invoices: [],
      logs: [],
      outputDir,
      cancelled: false,
      createdAt: new Date().toISOString(),
      options: {
        ruc,
        user,
        tipo,
        documento,
        sire,
        cpe,
        desde: desde.iso,
        hasta: hasta.iso,
        soloListar,
        descargarXml: !soloListar && body.descargarXml !== false,
        descargarPdf: !soloListar && body.descargarPdf !== false,
      },
    };

    jobs.set(id, job);
    writeJobFile(job);

    runJob(job, { ruc, user, password, documento }, options).catch((error) => {
      job.status = "error";
      job.error = error.message;
      job.message = "Error";
    });

    res.status(202).json({ jobId: id });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/empresas", (_req, res) => {
  res.json({ empresas: readEmpresas() });
});

app.post("/api/empresas", (req, res) => {
  try {
    const empresa = createEmpresa(req.body || {});
    res.status(201).json({ empresa });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.put("/api/empresas/:id", (req, res) => {
  try {
    const empresa = updateEmpresa(req.params.id, req.body || {});
    res.json({ empresa });
  } catch (error) {
    const status = /no encontrada/i.test(error.message) ? 404 : 400;
    res.status(status).json({ error: error.message });
  }
});

app.delete("/api/empresas/:id", (req, res) => {
  try {
    deleteEmpresa(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    const status = /no encontrada/i.test(error.message) ? 404 : 400;
    res.status(status).json({ error: error.message });
  }
});


app.get("/api/history", (req, res) => {
  const pageSize = Math.min(
    Math.max(Number(req.query.pageSize || req.query.limit || 20), 1),
    100,
  );
  const requestedPage = Math.max(Number(req.query.page) || 1, 1);

  const all = [...jobs.values()].sort(
    (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0),
  );
  const total = all.length;
  const totalPages = Math.max(Math.ceil(total / pageSize), 1);
  const page = Math.min(requestedPage, totalPages);
  const start = (page - 1) * pageSize;

  const items = all.slice(start, start + pageSize).map((job) => {
    const stats = jobStats(job);
    return {
      id: job.id,
      createdAt: job.createdAt,
      status: job.status,
      message: job.message,
      total: job.total,
      processed: job.processed,
      options: job.options,
      stats,
      hasFiles: stats.files > 0,
      hasOutput:
        job.hasOutput ??
        fs.existsSync(path.join(job.outputDir || "", "comprobantes.csv")),
    };
  });

  res.json({ items, total, page, pageSize, totalPages });
});

