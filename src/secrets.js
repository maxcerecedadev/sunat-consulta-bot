"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = process.env.SUNAT_DATA_DIR || process.cwd();
const KEY_FILE = path.join(DATA_DIR, ".buzon.key");
const PREFIX = "enc:v1:";

let cachedKey = null;

function loadKey() {
  if (cachedKey) return cachedKey;

  if (process.env.SUNAT_MASTER_KEY) {
    cachedKey = crypto.scryptSync(
      String(process.env.SUNAT_MASTER_KEY),
      "sunat-buzon-sol",
      32,
    );
    return cachedKey;
  }

  try {
    const existing = fs.readFileSync(KEY_FILE);
    if (existing.length === 32) {
      cachedKey = existing;
      return cachedKey;
    }
  } catch {
    // Se genera una clave local nueva.
  }

  cachedKey = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
  fs.writeFileSync(KEY_FILE, cachedKey, { mode: 0o600 });
  try {
    fs.chmodSync(KEY_FILE, 0o600);
  } catch {
    // En Windows chmod es limitado; el archivo queda en el perfil local.
  }
  return cachedKey;
}

function isEncrypted(value) {
  return String(value || "").startsWith(PREFIX);
}

function encryptSecret(value) {
  if (value === undefined || value === null || value === "") return "";
  if (isEncrypted(value)) return String(value);

  const key = loadKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(String(value), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString(
    "base64",
  )}`;
}

function decryptSecret(value) {
  if (!value) return "";
  if (!isEncrypted(value)) return String(value);

  const parts = String(value).slice(PREFIX.length).split(":");
  if (parts.length !== 3) throw new Error("La clave SOL guardada tiene un formato inválido.");

  const [iv, tag, encrypted] = parts;
  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      loadKey(),
      Buffer.from(iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error(
      "No se pudo descifrar la clave SOL. Si cambiaste SUNAT_MASTER_KEY, vuelve a registrarla.",
    );
  }
}

module.exports = { encryptSecret, decryptSecret, isEncrypted, KEY_FILE };
