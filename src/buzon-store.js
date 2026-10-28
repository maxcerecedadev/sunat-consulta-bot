"use strict";

const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.SUNAT_DATA_DIR || process.cwd();
const STATE_DIR = path.join(DATA_DIR, "buzon");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const MAX_ITEMS = 300;
const MAX_SEEN = 5000;

function emptyState() {
  return { version: 1, empresas: {} };
}

function readState() {
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (!data || typeof data !== "object" || !data.empresas) return emptyState();
    return data;
  } catch {
    return emptyState();
  }
}

function writeState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(STATE_FILE, 0o600);
  } catch {
    // En Windows el permiso se hereda del perfil del usuario.
  }
}

function getEmpresaState(ruc) {
  const state = readState();
  return state.empresas[String(ruc)] || null;
}

function readAllState() {
  return readState();
}

function sortItems(items) {
  return [...items].sort((a, b) => {
    const left = String(a.fecha_publicacion || a.fecha_envio || "");
    const right = String(b.fecha_publicacion || b.fecha_envio || "");
    return right.localeCompare(left);
  });
}

function applyCheck({ empresa, items }) {
  const state = readState();
  const key = String(empresa.ruc);
  const previous = state.empresas[key];
  const baseline = !previous || previous.baseline === true;

  const previousItems = new Map(
    (previous?.items || []).map((item) => [item.id, item]),
  );
  const seen = new Set(previous?.seen || []);
  const now = new Date().toISOString();

  const merged = [];
  const newItems = [];

  for (const item of items) {
    const exists = previousItems.get(item.id);
    const isNew = !baseline ? !seen.has(item.id) : false;

    const record = {
      ...item,
      empresa_id: empresa.id,
      empresa_nombre: empresa.nombre,
      ruc: empresa.ruc,
      nuevo: isNew,
      linea_base: exists ? Boolean(exists.linea_base) : baseline,
      detectado_en: exists?.detectado_en || now,
      enviado: Boolean(exists?.enviado),
      enviado_en: exists?.enviado_en || null,
      leido: Boolean(exists?.leido),
      adjuntos_descargados: Boolean(exists?.adjuntos_descargados),
      archivos: Array.isArray(exists?.archivos) ? exists.archivos : [],
      adjuntos_error: exists?.adjuntos_error || null,
      adjuntos_nota: exists?.adjuntos_nota || null,
    };

    if (isNew) newItems.push(record);
    seen.add(item.id);
    merged.push(record);
  }

  const mergedById = new Map(merged.map((item) => [item.id, item]));
  for (const item of previous?.items || []) {
    if (!mergedById.has(item.id)) merged.push(item);
  }

  state.empresas[key] = {
    ruc: empresa.ruc,
    nombre: empresa.nombre,
    baseline: false,
    last_check: now,
    last_error: null,
    items: sortItems(merged).slice(0, MAX_ITEMS),
    seen: [...seen].slice(-MAX_SEEN),
  };

  writeState(state);
  return {
    baseline,
    newItems,
    items: state.empresas[key].items,
  };
}

function recordError({ empresa, error }) {
  const state = readState();
  const key = String(empresa.ruc);
  const previous = state.empresas[key] || {
    ruc: empresa.ruc,
    nombre: empresa.nombre,
    baseline: true,
    items: [],
    seen: [],
  };

  state.empresas[key] = {
    ...previous,
    nombre: empresa.nombre,
    last_check: new Date().toISOString(),
    last_error: String(error || "Error desconocido."),
  };

  writeState(state);
}

function updateItem(ruc, id, patch) {
  const state = readState();
  const bucket = state.empresas[String(ruc)];
  if (!bucket) return null;

  let updated = null;
  bucket.items = (bucket.items || []).map((item) => {
    if (String(item.id) !== String(id) && String(item.codigo) !== String(id)) return item;
    updated = { ...item, ...patch };
    return updated;
  });

  if (updated) writeState(state);
  return updated;
}

function markSent(ruc, ids) {
  const state = readState();
  const bucket = state.empresas[String(ruc)];
  if (!bucket) return;

  const wanted = new Set(ids.map(String));
  const now = new Date().toISOString();

  bucket.items = (bucket.items || []).map((item) =>
    wanted.has(String(item.id)) || wanted.has(String(item.codigo))
      ? { ...item, enviado: true, enviado_en: now }
      : item,
  );

  writeState(state);
}

module.exports = {
  STATE_FILE,
  readAllState,
  getEmpresaState,
  applyCheck,
  recordError,
  markSent,
  updateItem,
};
