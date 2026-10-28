#!/usr/bin/env node
"use strict";

require("dotenv").config();

const { parseArgs } = require("util");
const { readEmpresas, getEmpresa } = require("./empresas");
const { checkEmpresa } = require("./buzon-service");
const { whatsapp } = require("./whatsapp-baileys");
const { sleep } = require("./util");

function help() {
  console.log(`
Buzón SOL -> WhatsApp

Uso:
  npm run buzon -- --all
  npm run buzon -- --empresa 20123456789 --enviar
  npm run buzon:watch -- --all --enviar --interval 15

Opciones:
  --all             Revisar todas las empresas activas (default).
  --empresa <id>    Revisar una sola empresa (id o RUC).
  --incluir-inactivas
  --enviar          Enviar por WhatsApp Web (Baileys) las novedades.
  --sin-nuevos      Enviar todo lo pendiente, no solo lo nuevo.
  --watch           Quedarse revisando cada N minutos.
  --interval <min>  Intervalo del modo --watch (default: 15).
  --max-pages <n>   Máximo de páginas por bandeja (default: 20).
  --visible         Mostrar el navegador (útil si SUNAT pide captcha).
  --descargar-adjuntos  Descargar PDFs y marcar los mensajes como leídos.
  --json            Imprimir el resultado como JSON.
  --help            Esta ayuda.

Advertencia: Baileys usa WhatsApp Web y no es un canal oficial. El número
puede ser bloqueado si envía demasiados mensajes. Para producción usa la API
oficial de WhatsApp Cloud o deja los mensajes listos para enviar manualmente.
`);
}

function parseMaxPages(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 100) {
    throw new Error("--max-pages debe ser un entero entre 1 y 100.");
  }
  return number;
}

function selectEmpresas(values) {
  if (values.empresa) {
    const empresa = getEmpresa(values.empresa, { withSecrets: true });
    if (!empresa) throw new Error(`No existe la empresa ${values.empresa}.`);
    return [empresa];
  }

  const all = readEmpresas({ withSecrets: true });
  const empresas = values["incluir-inactivas"]
    ? all
    : all.filter((empresa) => empresa.activo);

  if (empresas.length === 0) {
    throw new Error(
      "No hay empresas configuradas. Agrégalas desde la UI (pestaña Buzón SOL).",
    );
  }

  return empresas;
}

async function ensureWhatsApp() {
  const initial = whatsapp.status();
  if (initial.state === "connected") return true;

  if (!initial.available) {
    console.error(initial.error || "Baileys no está disponible.");
    return false;
  }

  console.log("Conectando WhatsApp Web...");
  await whatsapp.connect();

  let lastQr = "";
  const deadline = Date.now() + 120000;

  while (Date.now() < deadline) {
    const status = whatsapp.status();

    if (status.state === "connected") {
      console.log("WhatsApp conectado.");
      return true;
    }

    if (status.state === "unavailable" || status.state === "error") {
      console.error(status.error || "No se pudo conectar WhatsApp.");
      return false;
    }

    if (status.rawQr && status.rawQr !== lastQr) {
      lastQr = status.rawQr;
      try {
        const QRCode = require("qrcode");
        const terminal = await QRCode.toString(status.rawQr, {
          type: "terminal",
          small: true,
        });
        console.log("\nEscanea este QR desde WhatsApp > Dispositivos vinculados:\n");
        console.log(terminal);
      } catch {
        console.log(
          "Hay un QR pendiente. Abre la UI para escanearlo desde el navegador.",
        );
      }
    }

    await sleep(2000);
  }

  console.error("WhatsApp no se conectó a tiempo. Abre la UI y escanea el QR.");
  return whatsapp.status().state === "connected";
}

function printResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const empresa = result.empresa || {};
  console.log(`\n[${empresa.nombre || empresa.ruc}] ${empresa.ruc || ""}`);

  if (result.error) {
    console.error(`  Error: ${result.error}`);
    return;
  }

  if (result.baseline) {
    console.log(`  Línea base creada con ${result.total} registro(s). No se envían todavía.`);
  } else {
    console.log(
      `  ${result.total} registro(s), ${result.newCount} novedad(es)` +
        (result.enviados?.length ? `, ${result.enviados.length} enviada(s)` : ""),
    );
  }

  if (result.sendError) console.error(`  Error de WhatsApp: ${result.sendError}`);

  for (const item of result.newItems || []) {
    console.log(
      `  - [${item.tipo_label}] ${item.asunto} (${item.fecha_publicacion || item.fecha_envio || "sin fecha"})`,
    );
    if (item.wa_link) console.log(`    WhatsApp: ${item.wa_link}`);
  }
}

async function runOnce(values) {
  const empresas = selectEmpresas(values);
  const maxPages = values["max-pages"] ? parseMaxPages(values["max-pages"]) : undefined;
  let enviar = Boolean(values.enviar);

  if (enviar) {
    enviar = await ensureWhatsApp();
    if (!enviar) console.error("Se revisará el buzón, pero no se enviará nada.");
  }

  const results = [];

  for (const empresa of empresas) {
    try {
      const result = await checkEmpresa(empresa, {
        maxPages,
        enviar,
        visible: Boolean(values.visible),
        descargarAdjuntos: values["descargar-adjuntos"] ? true : undefined,
        soloNuevos: !values["sin-nuevos"],
        log: (message) => console.error(`[${empresa.ruc}] ${message}`),
      });
      results.push(result);
      printResult(result, Boolean(values.json));
    } catch (error) {
      const result = {
        empresa: {
          id: empresa.id,
          nombre: empresa.nombre,
          ruc: empresa.ruc,
          whatsapp: empresa.whatsapp,
        },
        error: error.message,
      };
      results.push(result);
      printResult(result, Boolean(values.json));
    }
  }

  return results;
}

async function main() {
  const { values } = parseArgs({
    options: {
      all: { type: "boolean" },
      empresa: { type: "string" },
      "incluir-inactivas": { type: "boolean" },
      enviar: { type: "boolean" },
      "sin-nuevos": { type: "boolean" },
      watch: { type: "boolean" },
      interval: { type: "string" },
      "max-pages": { type: "string" },
      visible: { type: "boolean" },
      "descargar-adjuntos": { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean" },
    },
    allowPositionals: false,
  });

  if (values.help) {
    help();
    return;
  }

  if (!values.watch) {
    await runOnce(values);
    return;
  }

  const minutes = Math.max(Number(values.interval || process.env.BUZON_INTERVAL_MIN || 15), 1);
  console.log(`Revisando el Buzón SOL cada ${minutes} minuto(s). Ctrl+C para salir.`);

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runOnce(values);
    } catch (error) {
      console.error(`Error: ${error.message}`);
    } finally {
      running = false;
    }
  };

  await tick();
  setInterval(tick, minutes * 60 * 1000);
}

main().catch((error) => {
  console.error(`\nError: ${error.message}\n`);
  process.exit(1);
});
