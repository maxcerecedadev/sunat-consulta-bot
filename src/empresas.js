"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { encryptSecret, decryptSecret } = require("./secrets");

const DATA_DIR = process.env.SUNAT_DATA_DIR || process.cwd();
const EMPRESAS_FILE = path.join(DATA_DIR, "empresas.json");

function normalizePhone(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 9 && digits.startsWith("9")) digits = `51${digits}`;
  return digits.slice(0, 15);
}

function validate(input, currentId = null) {
  const ruc = String(input.ruc || "").trim();
  const usuario = String(input.usuario || "").trim();
  const nombre = String(input.nombre || "").trim();
  const whatsapp = normalizePhone(input.whatsapp);

  if (!/^\d{11}$/.test(ruc)) throw new Error("El RUC debe tener 11 dígitos.");
  if (!usuario) throw new Error("El usuario SOL es obligatorio.");
  if (!whatsapp || whatsapp.length < 10) {
    throw new Error("El número de WhatsApp debe incluir el código de país.");
  }

  const existentes = readEmpresas({ withSecrets: true });
  if (existentes.some((empresa) => empresa.id !== currentId && empresa.ruc === ruc)) {
    throw new Error("Ya existe una empresa registrada con ese RUC.");
  }

  return {
    nombre: nombre || `RUC ${ruc}`,
    ruc,
    usuario,
    whatsapp,
    activo: input.activo !== false,
    autoEnviar: Boolean(input.autoEnviar),
    descargarAdjuntos: Boolean(input.descargarAdjuntos),
  };
}

function emptyFile() {
  return { empresas: [] };
}

function readFile() {
  try {
    const raw = JSON.parse(fs.readFileSync(EMPRESAS_FILE, "utf8"));
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.empresas) ? raw.empresas : [];
    return list;
  } catch {
    return [];
  }
}

function writeFile(empresas) {
  fs.mkdirSync(path.dirname(EMPRESAS_FILE), { recursive: true });
  fs.writeFileSync(EMPRESAS_FILE, `${JSON.stringify({ empresas }, null, 2)}\n`, {
    mode: 0o600,
  });
  try {
    fs.chmodSync(EMPRESAS_FILE, 0o600);
  } catch {
    // En Windows el permiso se hereda del perfil del usuario.
  }
}

function hydrate(empresa, withSecrets) {
  const item = {
    id: String(empresa.id || ""),
    nombre: String(empresa.nombre || `RUC ${empresa.ruc || ""}`),
    ruc: String(empresa.ruc || ""),
    usuario: String(empresa.usuario || ""),
    whatsapp: normalizePhone(empresa.whatsapp),
    activo: empresa.activo !== false,
    autoEnviar: Boolean(empresa.autoEnviar),
    descargarAdjuntos: Boolean(empresa.descargarAdjuntos),
    creado: empresa.creado || null,
    actualizado: empresa.actualizado || null,
    tieneClave: Boolean(empresa.clave),
  };

  if (withSecrets) {
    item.clave = decryptSecret(empresa.clave);
  } else {
    delete item.clave;
  }

  return item;
}

function readEmpresas({ withSecrets = false } = {}) {
  return readFile()
    .map((empresa) => {
      try {
        return hydrate(empresa, withSecrets);
      } catch (error) {
        return {
          ...hydrate({ ...empresa, clave: "" }, false),
          error: error.message,
        };
      }
    })
    .filter((empresa) => empresa.id && empresa.ruc);
}

function getEmpresa(idOrRuc, { withSecrets = true } = {}) {
  const key = String(idOrRuc || "");
  return (
    readEmpresas({ withSecrets }).find(
      (empresa) => empresa.id === key || empresa.ruc === key,
    ) || null
  );
}

function createEmpresa(input) {
  const data = validate(input);
  const clave = String(input.clave || "");
  if (!clave) throw new Error("La clave SOL es obligatoria.");

  const empresas = readFile();
  const now = new Date().toISOString();
  const empresa = {
    id: crypto.randomUUID(),
    ...data,
    clave: encryptSecret(clave),
    creado: now,
    actualizado: now,
  };

  empresas.push(empresa);
  writeFile(empresas);
  return hydrate(empresa, false);
}

function updateEmpresa(id, input) {
  const empresas = readFile();
  const index = empresas.findIndex((empresa) => empresa.id === id);
  if (index < 0) throw new Error("Empresa no encontrada.");

  const current = hydrate(empresas[index], true);
  const data = validate({ ...current, ...input }, id);
  const clave = String(input.clave || "").trim();

  const updated = {
    ...empresas[index],
    ...data,
    clave: clave ? encryptSecret(clave) : empresas[index].clave,
    actualizado: new Date().toISOString(),
  };

  empresas[index] = updated;
  writeFile(empresas);
  return hydrate(updated, false);
}

function deleteEmpresa(id) {
  const empresas = readFile();
  const next = empresas.filter((empresa) => empresa.id !== id);
  if (next.length === empresas.length) throw new Error("Empresa no encontrada.");
  writeFile(next);
}

module.exports = {
  EMPRESAS_FILE,
  normalizePhone,
  readEmpresas,
  getEmpresa,
  createEmpresa,
  updateEmpresa,
  deleteEmpresa,
};
