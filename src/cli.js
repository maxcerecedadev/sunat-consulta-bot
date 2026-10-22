#!/usr/bin/env node
"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { parseArgs } = require("util");
const prompts = require("prompts");
const { chromium } = require("playwright");
const {
  SunatClient,
  TIPOS,
  TIPOS_RECIBIDOS,
  DOCUMENTOS,
  tipoLabel,
} = require("./sunat-client");
const { parseUbl } = require("./ubl");
const {
  writeJson,
  writeCsv,
  buildRows,
  VOUCHER_COLUMNS,
  ITEM_COLUMNS,
} = require("./exporters");
const { parseDate, firstDayOfMonth, today } = require("./dates");
const { ensureDir, safeName, sleep } = require("./util");

const VERSION = "1.0.0";

function help() {
  console.log(`
Consulta SUNAT Bot v${VERSION}

Uso:
  npm start
  npm start -- --desde 2026-09-01 --hasta 2026-09-30 --tipo 10
  npm run consulta -- --ruc 20123456789 --user MIUSUARIO --password "******" --desde 2026-09-01 --hasta 2026-09-30

Opciones:
  --ruc         RUC del emisor/receptor (11 dígitos)
  --user        Usuario SOL
  --password    Clave SOL
  --desde       Fecha inicial (YYYY-MM-DD o DD/MM/YYYY)
  --hasta       Fecha final (YYYY-MM-DD o DD/MM/YYYY)
  --documento   factura | boleta (default: factura)
  --tipo        Código de consulta: 10 emitidas, 11 recibidas,
                12 rechazadas, 13/14 notas de crédito, 15/16 notas de débito
                (11/14/16 usan SIRE RCE y requieren un solo mes)
  --salida      Carpeta de salida (default: ./output/<fecha>_tipo<código>)
  --sin-pdf     No descargar PDF
  --sin-xml     No descargar XML (solo listado)
  --solo-listar No descargar archivos ni detalle
  --max         Máximo de comprobantes a procesar (útil para probar)
  --visible     Forzar navegador visible (útil si SUNAT pide captcha)
  --headless    Forzar navegador oculto (default)
  --doctor      Diagnóstico de instalación
  --help        Muestra esta ayuda

Tipos (aplican a facturas o boletas según --documento):
${Object.keys(TIPOS)
  .map((code) => `  ${code}  ${tipoLabel(code, "factura").replace(/^Facturas /, "")}`)
  .join("\n")}
`);
}

function fail(message) {
  console.error(`\nError: ${message}\n`);
  process.exit(1);
}

async function doctor() {
  console.log(`Node: ${process.version}`);
  console.log(`Playwright: ${require("playwright/package.json").version}`);

  const executable = chromium.executablePath();
  console.log(`Chromium: ${executable}`);
  console.log(`  ${fs.existsSync(executable) ? "OK" : "NO INSTALADO (ejecuta: npx playwright install chromium)"}`);
  console.log(`Directorio actual: ${process.cwd()}`);
  console.log(`Sesiones: ${path.join(process.cwd(), ".session")}`);
}

async function gatherOptions(values) {
  const missing = [];

  if (!values.ruc && !process.env.SUNAT_RUC) missing.push("ruc");
  if (!values.user && !process.env.SUNAT_USER) missing.push("user");
  if (!values.password && !process.env.SUNAT_PASSWORD) missing.push("password");

  let answers = {};
  if (missing.length > 0) {
    console.log("Faltan datos. Completa la configuración:\n");
    answers = await prompts(
      [
        {
          type: missing.includes("ruc") ? "text" : null,
          name: "ruc",
          message: "RUC",
          initial: process.env.SUNAT_RUC || "",
          validate: (value) => (/^\d{11}$/.test(value) ? true : "El RUC debe tener 11 dígitos."),
        },
        {
          type: missing.includes("user") ? "text" : null,
          name: "user",
          message: "Usuario SOL",
          initial: process.env.SUNAT_USER || "",
        },
        {
          type: missing.includes("password") ? "password" : null,
          name: "password",
          message: "Clave SOL",
        },
      ].filter((question) => question.type),
      { onCancel: () => process.exit(0) },
    );
  }

  const ruc = values.ruc || answers.ruc || process.env.SUNAT_RUC;
  const user = values.user || answers.user || process.env.SUNAT_USER;
  const password = values.password || answers.password || process.env.SUNAT_PASSWORD;

  if (!ruc || !user || !password) fail("Faltan las credenciales SOL.");

  let desde = values.desde || process.env.SUNAT_DESDE || firstDayOfMonth();
  let hasta = values.hasta || process.env.SUNAT_HASTA || today();
  let tipo = values.tipo || process.env.SUNAT_TIPO || "10";
  let documento = values.documento || process.env.SUNAT_DOCUMENTO || "factura";

  documento = String(documento).toLowerCase();
  if (!DOCUMENTOS[documento]) {
    fail(`Documento inválido: ${documento}. Usa factura o boleta.`);
  }

  if (!values.desde || !values.hasta || !values.tipo) {
    const interactive = await prompts(
      [
        {
          type: values.desde ? null : "text",
          name: "desde",
          message: "Fecha desde",
          initial: desde,
        },
        {
          type: values.hasta ? null : "text",
          name: "hasta",
          message: "Fecha hasta",
          initial: hasta,
        },
        {
          type: values.tipo ? null : "select",
          name: "tipo",
          message: "¿Qué comprobantes quieres consultar?",
          choices: Object.entries(TIPOS).map(([value]) => ({
            title: `${value} - ${tipoLabel(value, documento)}`,
            value,
          })),
          initial: 0,
        },
      ].filter((question) => question.type),
      { onCancel: () => process.exit(0) },
    );

    desde = values.desde || interactive.desde || desde;
    hasta = values.hasta || interactive.hasta || hasta;
    tipo = values.tipo || interactive.tipo || tipo;
  }

  tipo = String(tipo);
  if (!TIPOS[tipo]) fail(`Tipo inválido: ${tipo}. Usa 10 a 16.`);

  const desdeParsed = parseDate(desde, "Fecha desde");
  const hastaParsed = parseDate(hasta, "Fecha hasta");

  if (desdeParsed.iso > hastaParsed.iso) {
    fail("La fecha inicial no puede ser mayor que la final.");
  }

  if (
    TIPOS_RECIBIDOS.has(tipo) &&
    desdeParsed.iso.slice(0, 7) !== hastaParsed.iso.slice(0, 7)
  ) {
    fail("Para comprobantes recibidos selecciona un solo mes: se consultan desde el SIRE (RCE).");
  }

  return {
    ruc: String(ruc).trim(),
    user: String(user).trim(),
    password: String(password),
    desde: desdeParsed,
    hasta: hastaParsed,
    tipo,
    documento,
    outputDir:
      values.salida ||
      path.join(
        process.cwd(),
        "output",
        `${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}_tipo${tipo}`,
      ),
    downloadXml: !values["sin-xml"] && !values["solo-listar"],
    downloadPdf: !values["sin-pdf"] && !values["sin-xml"] && !values["solo-listar"],
    listOnly: Boolean(values["solo-listar"]),
    max: values.max ? Number(values.max) : null,
    headless: values.headless
      ? true
      : values.visible
        ? false
        : process.env.SUNAT_HEADLESS !== "false",
  };
}

async function run(values) {
  if (values.help) {
    help();
    return;
  }

  if (values.doctor) {
    await doctor();
    return;
  }

  const options = await gatherOptions(values);
  const client = new SunatClient({
    ruc: options.ruc,
    solUser: options.user,
    solPassword: options.password,
    documento: options.documento,
    sire: TIPOS_RECIBIDOS.has(options.tipo),
    headless: options.headless,
    statePath: path.join(process.cwd(), ".session", `${options.ruc}.json`),
    log: (message) => console.error(message),
  });

  console.log(`\nConsulta SUNAT`);
  console.log(`RUC: ${options.ruc}`);
  console.log(`Documento: ${DOCUMENTOS[options.documento]}`);
  console.log(`Tipo: ${options.tipo} - ${tipoLabel(options.tipo, options.documento)}`);
  console.log(`Rango: ${options.desde.iso} a ${options.hasta.iso}`);
  console.log(`Salida: ${options.outputDir}\n`);

  ensureDir(options.outputDir);
  if (options.downloadXml) ensureDir(path.join(options.outputDir, "xml"));
  if (options.downloadPdf) ensureDir(path.join(options.outputDir, "pdf"));
  ensureDir(path.join(options.outputDir, "cdr"));

  let invoices = [];
  const results = [];
  const errors = [];

  try {
    await client.open();
    invoices = await client.consultar({
      desde: options.desde.sunat,
      hasta: options.hasta.sunat,
      tipo: options.tipo,
    });

    if (options.max) invoices = invoices.slice(0, options.max);

    console.log(`SUNAT devolvió ${invoices.length} comprobante(s).\n`);

    if (invoices.length === 0) {
      writeJson(path.join(options.outputDir, "comprobantes.json"), {
        meta: meta(options),
        vouchers: [],
      });
      writeCsv(path.join(options.outputDir, "comprobantes.csv"), [], VOUCHER_COLUMNS);
      writeCsv(path.join(options.outputDir, "items.csv"), [], ITEM_COLUMNS);
      console.log("No hay comprobantes para exportar.");
      return;
    }

    for (let index = 0; index < invoices.length; index++) {
      const invoice = invoices[index];
      const label = `${invoice.numero_desc || `${invoice.serie}-${invoice.numero}`}`;
      process.stdout.write(`[${index + 1}/${invoices.length}] ${label} ... `);

      const result = {
        invoice,
        detail: null,
        xmlFile: "",
        pdfFile: "",
        cdrFile: "",
        error: "",
      };

      if (!options.listOnly) {
        try {
          const xml = await client.descargar(invoice, "xml");
          const fileName = `${safeName(invoice)}.xml`;
          const xmlPath = path.join(options.outputDir, "xml", fileName);

          if (options.downloadXml) {
            fs.writeFileSync(xmlPath, xml.content);
            result.xmlFile = path.relative(options.outputDir, xmlPath);
          }

          try {
            result.detail = parseUbl(xml.content.toString("utf8"));
          } catch (error) {
            result.error = `XML descargado pero no se pudo leer el detalle: ${error.message}`;
          }

          if (xml.cdr) {
            const cdrPath = path.join(options.outputDir, "cdr", `R-${safeName(invoice)}.xml`);
            fs.writeFileSync(cdrPath, xml.cdr, "utf8");
            result.cdrFile = path.relative(options.outputDir, cdrPath);
          }

          if (options.downloadPdf) {
            try {
              const pdf = await client.descargar(invoice, "pdf");
              const pdfPath = path.join(options.outputDir, "pdf", `${safeName(invoice)}.pdf`);
              fs.writeFileSync(pdfPath, pdf.content);
              result.pdfFile = path.relative(options.outputDir, pdfPath);
            } catch (error) {
              result.error = [result.error, `PDF: ${error.message}`].filter(Boolean).join(" | ");
            }
          }

          console.log(result.error ? `OK con aviso (${result.error})` : "OK");
        } catch (error) {
          result.error = error.message;
          errors.push({
            serie: invoice.serie,
            numero: invoice.numero,
            tipo: invoice.tipo,
            etapa: "descarga",
            error: error.message,
          });
          console.log(`ERROR: ${error.message}`);
        }
      } else {
        console.log("listado");
      }

      results.push(result);
      await sleep(350);
    }

    writeJson(path.join(options.outputDir, "comprobantes.json"), {
      meta: meta(options),
      vouchers: results.map((result) => ({
        ...result.invoice,
        detail: result.detail,
        files: {
          xml: result.xmlFile,
          pdf: result.pdfFile,
          cdr: result.cdrFile,
        },
        error: result.error,
      })),
    });

    const rows = buildRows(results);
    writeCsv(path.join(options.outputDir, "comprobantes.csv"), rows.vouchers, VOUCHER_COLUMNS);
    writeCsv(path.join(options.outputDir, "items.csv"), rows.items, ITEM_COLUMNS);
    writeCsv(path.join(options.outputDir, "errores.csv"), errors, [
      "serie",
      "numero",
      "tipo",
      "etapa",
      "error",
    ]);

    console.log(`\nListo. Archivos generados en: ${options.outputDir}`);
    console.log(`  comprobantes.json / comprobantes.csv`);
    if (!options.listOnly) console.log(`  items.csv / xml/ / pdf/ / cdr/`);
    if (errors.length) console.log(`  errores.csv (${errors.length} comprobante(s) con error)`);
  } finally {
    await client.close();
  }
}

function meta(options) {
  return {
    ruc: options.ruc,
    tipo: options.tipo,
    documento: options.documento,
    tipo_label: tipoLabel(options.tipo, options.documento),
    desde: options.desde.iso,
    hasta: options.hasta.iso,
    generated_at: new Date().toISOString(),
  };
}

const { values } = parseArgs({
  options: {
    ruc: { type: "string" },
    user: { type: "string" },
    password: { type: "string" },
    desde: { type: "string" },
    hasta: { type: "string" },
    documento: { type: "string" },
    tipo: { type: "string" },
    salida: { type: "string" },
    max: { type: "string" },
    "sin-pdf": { type: "boolean" },
    "sin-xml": { type: "boolean" },
    "solo-listar": { type: "boolean" },
    visible: { type: "boolean" },
    headless: { type: "boolean" },
    doctor: { type: "boolean" },
    help: { type: "boolean" },
  },
  allowPositionals: false,
});

run(values).catch((error) => fail(error.message));
