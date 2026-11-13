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

app.get("/api/buzon/state", (_req, res) => {
  const state = readAllState();
  const empresas = readEmpresas().map((empresa) => {
    const bucket = state.empresas?.[empresa.ruc];
    return {
      ...empresa,
      lastCheck: bucket?.last_check || null,
      lastError: bucket?.last_error || null,
      baseline: bucket?.baseline ?? true,
      items: decorateItems(empresa, bucket?.items || []),
    };
  });

  res.json({ empresas });
});

app.post("/api/buzon/check", (req, res) => {
  try {
    const body = req.body || {};
    let empresas = [];

    if (body.empresaId) {
      const empresa = getEmpresa(body.empresaId, { withSecrets: true });
      if (!empresa) throw new Error("Empresa no encontrada.");
      empresas = [empresa];
    } else {
      empresas = readEmpresas({ withSecrets: true }).filter((empresa) => empresa.activo);
    }

    if (empresas.length === 0) {
      throw new Error("No hay empresas activas para revisar.");
    }

    const id = crypto.randomUUID();
    const job = {
      id,
      status: "queued",
      message: "En cola...",
      error: null,
      results: [],
      logs: [],
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };

    buzonJobs.set(id, job);

    const log = (message) => {
      job.logs.push({ at: new Date().toISOString(), message });
      if (job.logs.length > 200) job.logs.shift();
    };

    job.status = "running";
    job.message = `Revisando ${empresas.length} empresa(s)...`;

    checkAll({
      empresas,
      visible: Boolean(body.visible),
      descargarAdjuntos:
        typeof body.descargarAdjuntos === "boolean" ? body.descargarAdjuntos : undefined,
      log,
    })
      .then((results) => {
        job.results = results;
        job.status = "done";
        const novedades = results.reduce(
          (total, result) => total + (result.newCount || 0),
          0,
        );
        const baseTotal = results
          .filter((result) => result.baseline)
          .reduce((total, result) => total + (result.total || 0), 0);
        const errores = results.filter((result) => result.error).length;
        job.message = errores
          ? `Revisión completada con ${errores} empresa(s) con error.`
          : baseTotal > 0
            ? `Primera revisión: ${baseTotal} registro(s) guardados como línea base. No se enviaron; aparecen en Pendientes para que los prepares.`
            : novedades > 0
              ? `Revisión completada: ${novedades} novedad(es).`
              : "Revisión completada: sin novedades.";
        job.finishedAt = new Date().toISOString();
      })
      .catch((error) => {
        job.status = "error";
        job.error = error.message;
        job.message = "No se pudo completar la revisión.";
        job.finishedAt = new Date().toISOString();
      });

    res.status(202).json({ jobId: id });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/buzon/jobs/:id", (req, res) => {
  const job = buzonJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Revisión no encontrada." });

  res.json({
    id: job.id,
    status: job.status,
    message: job.message,
    error: job.error,
    results: job.results,
    logs: job.logs.slice(-60),
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  });
});

app.get("/api/buzon/prepared/:id", (req, res) => {
  const empresa = getEmpresa(req.params.id, { withSecrets: true });
  if (!empresa) return res.status(404).json({ error: "Empresa no encontrada." });

  res.json({
    empresa: {
      id: empresa.id,
      nombre: empresa.nombre,
      ruc: empresa.ruc,
      whatsapp: empresa.whatsapp,
    },
    items: getPreparedItems(empresa),
  });
});

app.get("/api/buzon/attachments/:empresaId/:itemId/:name", (req, res) => {
  const empresa = getEmpresa(req.params.empresaId, { withSecrets: false });
  if (!empresa) return res.status(404).json({ error: "Empresa no encontrada." });

  const file = attachmentFile(
    empresa,
    { id: req.params.itemId },
    req.params.name,
  );

  if (!fs.existsSync(file)) {
    return res.status(404).json({ error: "Adjunto no encontrado." });
  }

  res.download(file, path.basename(file));
});

app.post("/api/buzon/send", async (req, res) => {
  try {
    const { empresaId, ids, text } = req.body || {};
    if (!empresaId) throw new Error("Selecciona una empresa.");
    const result = await sendPrepared({ empresaId, ids, text });
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/buzon/mark-sent", (req, res) => {
  try {
    const { ruc, ids } = req.body || {};
    if (!ruc || !Array.isArray(ids)) throw new Error("Datos incompletos.");
    markSent(ruc, ids);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/whatsapp/status", (_req, res) => {
  res.json(whatsapp.status());
});

app.post("/api/whatsapp/connect", async (_req, res) => {
  try {
    const status = await whatsapp.connect();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/whatsapp/logout", async (_req, res) => {
  try {
    const status = await whatsapp.logout();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

