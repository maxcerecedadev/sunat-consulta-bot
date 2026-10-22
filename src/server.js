"use strict";

require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { exec } = require("child_process");
const { ZipArchive } = require("archiver");
const {
  SunatClient,
  TIPOS,
  TIPO_LABELS,
  DOCUMENTOS,
  TIPOS_RECIBIDOS,
  tipoLabel,
} = require("./sunat-client");
const { parseUbl } = require("./ubl");
const { parseDate } = require("./dates");
const { ensureDir, safeName, sleep } = require("./util");
const {
  writeJson,
  writeCsv,
  buildRows,
  VOUCHER_COLUMNS,
  ITEM_COLUMNS,
} = require("./exporters");

const app = express();
const PORT = Number(process.env.UI_PORT || 3131);
const HOST = "127.0.0.1";
const DATA_DIR = process.env.SUNAT_DATA_DIR || process.cwd();
const UI_DIR =
  process.env.SUNAT_UI_DIR || path.join(__dirname, "..", "ui-dist");
const OUTPUT_ROOT = path.join(DATA_DIR, "output", "ui");

app.use(express.json({ limit: "1mb" }));
app.use(express.static(UI_DIR));

const jobs = new Map();
const clients = new Map();

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

  const items = all.slice(start, start + pageSize).map((job) => ({
    id: job.id,
    createdAt: job.createdAt,
    status: job.status,
    message: job.message,
    total: job.total,
    processed: job.processed,
    options: job.options,
    hasOutput:
      job.hasOutput ??
      fs.existsSync(path.join(job.outputDir || "", "comprobantes.csv")),
  }));

  res.json({ items, total, page, pageSize, totalPages });
});

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

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Consulta no encontrada." });

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

function sunatDate(value) {
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
    const [year, month, day] = value.slice(0, 10).split("-");
    return `${day}/${month}/${year}`;
  }
  return value;
}

async function runJob(job, credentials, options) {
  if (job.cancelled) {
    job.status = "cancelled";
    job.message = "Consulta cancelada.";
    writeOutputs(job);
    return;
  }

  const client = new SunatClient({
    ruc: credentials.ruc,
    solUser: credentials.user,
    solPassword: credentials.password,
    documento: credentials.documento,
    sire: options.sire,
    headless: options.headless,
    statePath: path.join(DATA_DIR, ".session", `${credentials.ruc}.json`),
    log: (message) => {
      job.logs.push({ at: new Date().toISOString(), message });
      if (job.logs.length > 200) job.logs.shift();
    },
  });

  clients.set(job.id, client);

  try {
    job.status = "login";
    job.message = "Iniciando sesión en SUNAT...";
    await client.open();

    job.status = "listing";
    job.message = "Consultando comprobantes en SUNAT...";
    let invoices = await client.consultar({
      desde: options.desde.sunat,
      hasta: options.hasta.sunat,
      tipo: options.tipo,
    });

    if (options.max) invoices = invoices.slice(0, options.max);

    job.total = invoices.length;
    job.message = invoices.length
      ? `Procesando ${invoices.length} comprobante(s)...`
      : "SUNAT no devolvió comprobantes para el rango seleccionado.";

    if (invoices.length === 0) {
      job.status = "done";
      writeOutputs(job);
      return;
    }

    job.status = "processing";

    const processInvoice = async (invoice) => {
      const record = {
        id: invoice.id,
        tipo: invoice.tipo,
        tipo_label: invoice.tipo_label,
        serie: invoice.serie,
        numero: invoice.numero,
        numero_desc: invoice.numero_desc,
        fecha: invoice.fecha,
        ruc_emisor: invoice.ruc_emisor,
        emisor: invoice.emisor,
        ruc_receptor: invoice.ruc_receptor,
        receptor: invoice.receptor,
        total: invoice.total,
        moneda: invoice.moneda,
        estado: invoice.estado,
        detail: null,
        files: {},
        error: null,
      };

      if (!options.soloListar) {
        if (options.sire) client.log(`Descargando ${invoice.numero_desc}...`);
        const base = safeName(invoice);

        try {
          const xml = await client.descargar(invoice, "xml");

          if (options.descargarXml) {
            const xmlPath = path.join(job.outputDir, "xml", `${base}.xml`);
            fs.writeFileSync(xmlPath, xml.content);
            record.files.xml = `xml/${base}.xml`;
          }

          try {
            record.detail = parseUbl(xml.content.toString("utf8"));
          } catch (error) {
            record.error = `XML descargado, pero no se pudo leer el detalle: ${error.message}`;
          }

          // El listado del portal no siempre trae razón social, total ni
          // estado; el XML sí. Se completa el registro para la tabla y los
          // exports sin cambiar `tipo`, que se usa para descargar.
          if (record.detail) {
            const detail = record.detail;
            record.tipo_label = TIPO_LABELS[detail.tipo] || record.tipo_label;
            record.fecha = record.fecha || sunatDate(detail.fecha);
            record.emisor = record.emisor || detail.emisor.name || "";
            record.ruc_emisor = record.ruc_emisor || detail.emisor.doc_number || "";
            record.receptor = record.receptor || detail.cliente.name || "";
            record.ruc_receptor = record.ruc_receptor || detail.cliente.doc_number || "";
            record.total = record.total ?? detail.totals.total;
            record.moneda = record.moneda || detail.moneda || "";
            record.estado = record.estado || "Aceptado";
          }

          if (xml.cdr) {
            const cdrPath = path.join(job.outputDir, "cdr", `R-${base}.xml`);
            fs.writeFileSync(cdrPath, xml.cdr, "utf8");
            record.files.cdr = `cdr/R-${base}.xml`;
          }
        } catch (error) {
          record.error = `XML: ${error.message}`;
        }

        // Si el XML falló, el CDR puede seguir disponible por separado.
        if (options.sire && !record.files.cdr) {
          try {
            const cdr = await client.descargar(invoice, "cdr");
            const cdrPath = path.join(job.outputDir, "cdr", `R-${base}.xml`);
            fs.writeFileSync(cdrPath, cdr.content);
            record.files.cdr = `cdr/R-${base}.xml`;
          } catch (error) {
            record.error = [record.error, `CDR: ${error.message}`].filter(Boolean).join(" | ");
          }
        }

        // El PDF se intenta aunque el XML haya fallado.
        if (options.descargarPdf) {
          try {
            const pdf = await client.descargar(invoice, "pdf");
            const pdfPath = path.join(job.outputDir, "pdf", `${base}.pdf`);
            fs.writeFileSync(pdfPath, pdf.content);
            record.files.pdf = `pdf/${base}.pdf`;
          } catch (error) {
            record.error = [record.error, `PDF: ${error.message}`].filter(Boolean).join(" | ");
          }
        }
      }

      return record;
    };

    // SIRE/consultacpe responde lento (~10 s por archivo); se procesan varios
    // comprobantes en paralelo para que 100 compras no tarden una hora.
    const concurrency = options.sire
      ? Math.min(Math.max(Number(process.env.SUNAT_CONCURRENCY || 2), 1), 5)
      : 1;

    const processed = [];

    for (let index = 0; index < invoices.length; index += concurrency) {
      if (job.cancelled) break;

      const chunk = invoices.slice(index, index + concurrency);
      const items = await Promise.all(
        chunk.map(async (invoice) => ({
          invoice,
          record: await processInvoice(invoice),
        })),
      );

      for (const item of items) {
        job.invoices.push(item.record);
        processed.push(item);
        job.processed = job.invoices.length;
        job.message = `${job.processed} de ${job.total} comprobante(s) procesado(s)...`;
      }

      await sleep(options.sire ? 800 : 300);
    }

    // SIRE/consultacpe devuelve 500 intermitentes. Se reintentan una vez, de
    // forma secuencial, solo los comprobantes que quedaron con error.
    if (options.sire && !job.cancelled) {
      const failed = processed.filter((item) => item.record.error);

      if (failed.length > 0) {
        client.log(`Reintentando ${failed.length} comprobante(s) con error...`);
        job.message = `Reintentando ${failed.length} comprobante(s) con error...`;

        for (const item of failed) {
          if (job.cancelled) break;
          await sleep(5000);
          client.log(`Reintentando ${item.invoice.numero_desc}...`);

          const retry = await processInvoice(item.invoice);
          const index = job.invoices.findIndex((record) => record.id === item.record.id);
          if (index >= 0) job.invoices[index] = retry;

          const pending = job.invoices.filter((record) => record.error).length;
          job.message = `Reintento: ${pending} comprobante(s) con error...`;
        }
      }
    }

    const errorCount = job.invoices.filter((record) => record.error).length;
    job.status = job.cancelled ? "cancelled" : "done";
    job.message = job.cancelled
      ? "Consulta cancelada."
      : errorCount > 0
        ? `Consulta completada con ${errorCount} comprobante(s) con error.`
        : "Consulta completada.";
    writeOutputs(job);
  } catch (error) {
    if (job.cancelled) {
      job.status = "cancelled";
      job.message = "Consulta cancelada.";
    } else {
      job.status = "error";
      job.error = error.message;
      job.message = "No se pudo completar la consulta.";
    }
    writeOutputs(job);
  } finally {
    clients.delete(job.id);
    await client.close();
  }
}

function writeOutputs(job) {
  const results = job.invoices.map((record) => ({
    invoice: record,
    detail: record.detail,
    xmlFile: record.files.xml || "",
    pdfFile: record.files.pdf || "",
    cdrFile: record.files.cdr || "",
    error: record.error || "",
  }));

  const rows = buildRows(results);

  writeJson(path.join(job.outputDir, "comprobantes.json"), {
    meta: {
      ruc: job.options.ruc,
      tipo: job.options.tipo,
      documento: job.options.documento,
      tipo_label: tipoLabel(job.options.tipo, job.options.documento),
      desde: job.options.desde,
      hasta: job.options.hasta,
      generated_at: new Date().toISOString(),
      cancelled: job.cancelled,
    },
    vouchers: job.invoices,
  });

  writeCsv(path.join(job.outputDir, "comprobantes.csv"), rows.vouchers, VOUCHER_COLUMNS);
  writeCsv(path.join(job.outputDir, "items.csv"), rows.items, ITEM_COLUMNS);
  writeCsv(
    path.join(job.outputDir, "errores.csv"),
    job.invoices
      .filter((record) => record.error)
      .map((record) => ({
        serie: record.serie,
        numero: record.numero,
        tipo: record.tipo,
        etapa: "descarga",
        error: record.error,
      })),
    ["serie", "numero", "tipo", "etapa", "error"],
  );

  writeJobFile(job);
}

function writeJobFile(job) {
  if (!job.outputDir) return;

  try {
    ensureDir(job.outputDir);
    writeJson(path.join(job.outputDir, "job.json"), {
      id: job.id,
      status: job.status,
      message: job.message,
      error: job.error,
      total: job.total,
      processed: job.processed,
      cancelled: job.cancelled,
      invoices: job.invoices,
      logs: job.logs.slice(-100),
      options: job.options,
      createdAt: job.createdAt,
      hasOutput: fs.existsSync(path.join(job.outputDir, "comprobantes.csv")),
    });
  } catch (error) {
    console.error("No se pudo guardar el historial:", error.message);
  }
}

function loadHistory() {
  if (!fs.existsSync(OUTPUT_ROOT)) return;

  const entries = [];

  for (const dir of fs.readdirSync(OUTPUT_ROOT, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;

    const file = path.join(OUTPUT_ROOT, dir.name, "job.json");
    if (!fs.existsSync(file)) continue;

    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!data.id) data.id = dir.name;

      data.outputDir = path.join(OUTPUT_ROOT, dir.name);

      if (!["done", "error", "cancelled"].includes(data.status)) {
        data.status = "error";
        data.error = data.error || "Consulta interrumpida.";
        data.message = "Consulta interrumpida (el servidor se reinició).";
      }

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
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();

  const indexFile = path.join(UI_DIR, "index.html");
  if (!fs.existsSync(indexFile)) {
    return res
      .status(503)
      .send("La UI no está compilada. Ejecuta: npm run build:ui (o npm run ui).");
  }

  res.sendFile(indexFile);
});

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

const server = app.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`\nConsulta SUNAT UI: ${url}`);
  console.log("Cierra esta ventana (Ctrl+C) para detener el servidor.\n");
  openBrowser(url);
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`\nEl puerto ${PORT} ya está en uso.`);
    console.error("Cierra la instancia anterior o usa otro puerto:");
    console.error(`  UI_PORT=3132 npm run ui\n`);
    console.error(`Para encontrar el proceso: ss -ltnp | grep ${PORT}\n`);
    process.exit(1);
  }

  throw error;
});
