"use strict";

const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const { SunatClient } = require("./sunat-client");
const { getEmpresa } = require("./empresas");
const {
  applyCheck,
  recordError,
  markSent,
  updateItem,
  getEmpresaState,
} = require("./buzon-store");
const { BUZON_LINK, buildMessage, waLink } = require("./whatsapp");
const { whatsapp } = require("./whatsapp-baileys");
const { sleep } = require("./util");

const DATA_DIR = process.env.SUNAT_DATA_DIR || process.cwd();
const MAX_PAGES = Number(process.env.BUZON_MAX_PAGES || 20);
const ATTACHMENTS_ROOT = path.join(DATA_DIR, "buzon", "attachments");

function itemFolder(id) {
  return String(id || "mensaje").replace(/[^0-9A-Za-z_-]/g, "_");
}

function safeAttachmentName(name, fallback) {
  const base = path
    .basename(String(name || ""))
    .replace(/[^0-9A-Za-z._-]+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 140);
  return base || fallback;
}

function attachmentFile(empresa, item, name) {
  return path.join(
    ATTACHMENTS_ROOT,
    String(empresa.ruc),
    itemFolder(item.id),
    safeAttachmentName(name, "adjunto"),
  );
}

function decorateItem(empresa, item) {
  const mensaje = buildMessage(empresa, item);
  const archivos = (Array.isArray(item.archivos) ? item.archivos : []).map((archivo) => ({
    ...archivo,
    url: `/api/buzon/attachments/${encodeURIComponent(empresa.id)}/${encodeURIComponent(
      item.id,
    )}/${encodeURIComponent(archivo.nombre)}`,
  }));

  return {
    ...item,
    empresa_id: empresa.id,
    empresa_nombre: empresa.nombre,
    ruc: empresa.ruc,
    mensaje,
    wa_link: waLink(empresa.whatsapp, mensaje),
    buzon_link: BUZON_LINK,
    archivos,
  };
}

function decorateItems(empresa, items) {
  return (items || []).map((item) => decorateItem(empresa, item));
}

function createClient(empresa, log, options = {}) {
  return new SunatClient({
    ruc: empresa.ruc,
    solUser: empresa.usuario,
    solPassword: empresa.clave,
    buzon: true,
    headless: options.visible ? false : process.env.SUNAT_HEADLESS !== "false",
    statePath: path.join(DATA_DIR, ".session", `${empresa.ruc}.json`),
    log,
  });
}

async function descargarAdjuntosItem(client, empresa, item) {
  const detalle = await client.obtenerDetalleBuzon(item);
  const list = Array.isArray(detalle?.listAttach) ? detalle.listAttach : [];
  const adjuntos = list.filter(
    (archivo) =>
      archivo &&
      archivo.nomArchivo &&
      archivo.codArchivo !== undefined &&
      (archivo.indMensaje === undefined || ["1", "2"].includes(String(archivo.indMensaje))),
  );

  const dir = path.join(ATTACHMENTS_ROOT, String(empresa.ruc), itemFolder(item.id));
  fs.mkdirSync(dir, { recursive: true });

  const archivos = [];
  const nombres = new Set();
  const hashes = new Set();
  let duplicados = 0;
  let errores = 0;

  for (const adjunto of adjuntos) {
    try {
      const descargado = await client.descargarAdjuntoBuzon(item, adjunto, detalle);
      const hash = crypto.createHash("md5").update(descargado.content).digest("hex");

      if (hashes.has(hash)) {
        duplicados += 1;
        continue;
      }
      hashes.add(hash);

      let nombre = safeAttachmentName(
        descargado.filename || adjunto.nomArchivo,
        `adjunto-${adjunto.codArchivo}.pdf`,
      );

      if (nombres.has(nombre)) {
        nombre = `${adjunto.codArchivo}-${nombre}`;
      }
      nombres.add(nombre);

      fs.writeFileSync(path.join(dir, nombre), descargado.content);
      archivos.push({
        nombre,
        cod_archivo: adjunto.codArchivo,
        tamano: descargado.content.length,
        mime: descargado.mime,
      });
    } catch {
      errores += 1;
    }
    await sleep(500);
  }

  const nota =
    duplicados > 0
      ? `SUNAT devolvió el mismo archivo para ${duplicados} adjunto(s).`
      : errores > 0
        ? `No se pudieron descargar ${errores} adjunto(s).`
        : null;

  return { archivos, leido: true, nota };
}

async function enviarItem(empresa, item) {
  await whatsapp.send(empresa.whatsapp, item.mensaje);

  for (const archivo of item.archivos || []) {
    const file = attachmentFile(empresa, item, archivo.nombre);
    if (!fs.existsSync(file)) continue;
    await whatsapp.sendDocument(empresa.whatsapp, {
      content: fs.readFileSync(file),
      filename: archivo.nombre,
      mimetype: archivo.mime,
    });
  }
}

async function checkEmpresa(empresa, options = {}) {
  if (!empresa.clave) {
    throw new Error("La empresa no tiene clave SOL registrada.");
  }

  const log = options.log || (() => undefined);
  const maxPages = options.maxPages || MAX_PAGES;
  const descargarAdjuntos =
    options.descargarAdjuntos === undefined
      ? Boolean(empresa.descargarAdjuntos)
      : Boolean(options.descargarAdjuntos);
  const client = createClient(empresa, log, options);

  try {
    log(`Consultando Buzón SOL de ${empresa.nombre} (${empresa.ruc})...`);
    await client.open();
    const items = await client.listarBuzon({ tipo: "todos", maxPages });
    const result = applyCheck({ empresa, items });

    if (descargarAdjuntos) {
      const pendientes = result.items.filter(
        (item) => item.adjuntos > 0 && !item.adjuntos_descargados,
      );

      if (pendientes.length > 0) {
        log(
          `Descargando adjuntos de ${pendientes.length} mensaje(s). Se marcarán como leídos en SUNAT...`,
        );
      }

      for (const item of pendientes) {
        try {
          const data = await client.withRetry(() =>
            descargarAdjuntosItem(client, empresa, item),
          );
          updateItem(empresa.ruc, item.id, {
            archivos: data.archivos,
            leido: true,
            adjuntos_descargados: data.archivos.length > 0,
            adjuntos_error: null,
            adjuntos_nota: data.nota || null,
            detalle_abierto_en: new Date().toISOString(),
          });
          log(
            `"${item.asunto}": ${data.archivos.length} adjunto(s) descargado(s).` +
              (data.nota ? ` ${data.nota}` : ""),
          );
        } catch (error) {
          updateItem(empresa.ruc, item.id, {
            leido: true,
            adjuntos_error: error.message,
            detalle_abierto_en: new Date().toISOString(),
          });
          log(`No se pudieron descargar los adjuntos de "${item.asunto}": ${error.message}`);
          if (/sesión|session|expir|autenticacion/i.test(error.message)) throw error;
        }
        await sleep(800);
      }
    }

    const finalState = getEmpresaState(empresa.ruc);
    const decorated = decorateItems(empresa, finalState?.items || result.items);
    const decorateById = new Map(decorated.map((item) => [item.id, item]));
    const newItems = result.newItems
      .map((item) => decorateById.get(item.id) || decorateItem(empresa, item))
      .filter(Boolean);

    let enviados = [];
    let sendError = null;

    if (options.enviar && !result.baseline) {
      const pending = decorated.filter((item) => !item.enviado && !item.linea_base);
      if (options.soloNuevos) {
        const ids = new Set(newItems.map((item) => item.id));
        pending.splice(0, pending.length, ...pending.filter((item) => ids.has(item.id)));
      }

      if (pending.length > 0) {
        try {
          for (const item of pending) {
            await enviarItem(empresa, item);
            enviados.push(item.id);
          }
        } catch (error) {
          sendError = error.message;
        } finally {
          if (enviados.length > 0) markSent(empresa.ruc, enviados);
        }
      }
    }

    log(
      result.baseline
        ? `Primera revisión de ${empresa.ruc}: ${items.length} registro(s) como línea base.`
        : `Buzón de ${empresa.ruc}: ${result.newItems.length} novedad(es).`,
    );

    return {
      empresa: {
        id: empresa.id,
        nombre: empresa.nombre,
        ruc: empresa.ruc,
        whatsapp: empresa.whatsapp,
      },
      baseline: result.baseline,
      total: items.length,
      newCount: result.newItems.length,
      newItems,
      items: decorated,
      enviados,
      sendError,
    };
  } catch (error) {
    recordError({ empresa, error: error.message });
    throw error;
  } finally {
    await client.close();
  }
}

async function checkAll({
  empresas,
  enviar = false,
  soloNuevos = false,
  visible = false,
  descargarAdjuntos,
  log,
} = {}) {
  const results = [];

  for (const empresa of empresas) {
    try {
      results.push(
        await checkEmpresa(empresa, {
          enviar,
          soloNuevos,
          visible,
          descargarAdjuntos,
          log,
        }),
      );
    } catch (error) {
      log?.(`Error en ${empresa.ruc}: ${error.message}`);
      results.push({
        empresa: {
          id: empresa.id,
          nombre: empresa.nombre,
          ruc: empresa.ruc,
          whatsapp: empresa.whatsapp,
        },
        error: error.message,
        items: decorateItems(empresa, getEmpresaState(empresa.ruc)?.items || []),
      });
    }
  }

  return results;
}

function getPreparedItems(empresa) {
  const bucket = getEmpresaState(empresa.ruc);
  return decorateItems(empresa, bucket?.items || []);
}

async function sendPrepared({ empresaId, ids = [], text = "" }) {
  const empresa = getEmpresa(empresaId, { withSecrets: true });
  if (!empresa) throw new Error("Empresa no encontrada.");

  const bucket = getEmpresaState(empresa.ruc);
  const items = decorateItems(empresa, bucket?.items || []);
  const wanted = new Set(ids.map(String));
  const seleccionados = items.filter(
    (item) => wanted.has(String(item.id)) || wanted.has(String(item.codigo)),
  );

  let mensajes = [];
  if (text.trim()) {
    mensajes = [{ ids: seleccionados.map((item) => item.id), text: text.trim(), items: seleccionados }];
  } else {
    mensajes = seleccionados.map((item) => ({
      ids: [item.id],
      text: item.mensaje,
      items: [item],
    }));
  }

  if (mensajes.length === 0) throw new Error("No hay mensajes para enviar.");

  const enviados = [];
  let marcar = [];

  try {
    for (const mensaje of mensajes) {
      await whatsapp.send(empresa.whatsapp, mensaje.text);

      for (const item of mensaje.items) {
        for (const archivo of item.archivos || []) {
          const file = attachmentFile(empresa, item, archivo.nombre);
          if (!fs.existsSync(file)) continue;
          await whatsapp.sendDocument(empresa.whatsapp, {
            content: fs.readFileSync(file),
            filename: archivo.nombre,
            mimetype: archivo.mime,
          });
        }
      }

      enviados.push(...mensaje.ids);
    }
    marcar = enviados.length > 0 ? enviados : text.trim() ? ids : [];
  } finally {
    if (marcar.length > 0 || enviados.length > 0) {
      markSent(empresa.ruc, marcar.length > 0 ? marcar : enviados);
    }
  }

  return { ok: true, enviados: marcar, whatsapp: empresa.whatsapp };
}

module.exports = {
  checkEmpresa,
  checkAll,
  getPreparedItems,
  decorateItems,
  sendPrepared,
  attachmentFile,
  safeAttachmentName,
  itemFolder,
  descargarAdjuntosItem,
};
