"use strict";

const fs = require("fs");
const path = require("path");
const { normalizePhone } = require("./whatsapp");

const DATA_DIR = process.env.SUNAT_DATA_DIR || process.cwd();
const AUTH_DIR = path.join(DATA_DIR, "whatsapp-auth");

let baileys = null;
let baileysError = null;
let loadAttempted = false;

function loadBaileys() {
  if (loadAttempted) return baileys;
  loadAttempted = true;
  try {
    baileys = require("@whiskeysockets/baileys");
  } catch (error) {
    baileysError =
      "Baileys no está instalado. Ejecuta: npm install @whiskeysockets/baileys qrcode";
  }
  return baileys;
}

class WhatsAppManager {
  constructor() {
    this.state = "disconnected";
    this.qr = null;
    this.qrRaw = null;
    this.qrDataUrl = null;
    this.error = null;
    this.me = null;
    this.sock = null;
    this.connecting = null;
    this.reconnectTimer = null;
    this.attempts = 0;
    this.lastUpdate = new Date().toISOString();
  }

  touch() {
    this.lastUpdate = new Date().toISOString();
  }

  status() {
    const available = Boolean(loadBaileys());
    return {
      available,
      state: available ? this.state : "unavailable",
      qr: this.qrDataUrl,
      rawQr: this.qrRaw,
      me: this.me,
      error: available ? this.error : baileysError,
      lastUpdate: this.lastUpdate,
      authDir: AUTH_DIR,
      warning:
        "WhatsApp Web (Baileys) no es oficial. SUNAT no tiene relación con esto y WhatsApp podría bloquear el número si envía demasiados mensajes. Úsalo con moderación.",
    };
  }

  async connect() {
    const lib = loadBaileys();
    if (!lib) {
      this.state = "unavailable";
      this.error = baileysError;
      return this.status();
    }

    if (this.state === "connected") return this.status();
    if (this.connecting) return this.connecting;

    this.connecting = this.start(lib)
      .catch((error) => {
        this.state = "error";
        this.error = error.message;
        this.touch();
      })
      .finally(() => {
        this.connecting = null;
      });

    return this.connecting;
  }

  async start(lib) {
    const {
      useMultiFileAuthState,
      fetchLatestBaileysVersion,
      Browsers,
      makeWASocket,
    } = lib;
    const makeSocket =
      makeWASocket || (typeof lib.default === "function" ? lib.default : null);
    if (!makeSocket) throw new Error("La versión instalada de Baileys no es compatible.");

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.sock) {
      this.sock.ev.removeAllListeners("connection.update");
      this.sock.ev.removeAllListeners("creds.update");
      this.sock.end(new Error("Reconectando WhatsApp."));
      this.sock = null;
    }

    fs.mkdirSync(AUTH_DIR, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const version = await fetchLatestBaileysVersion()
      .then((result) => result.version)
      .catch(() => undefined);

    this.state = "connecting";
    this.error = null;
    this.qr = null;
    this.qrDataUrl = null;
    this.touch();

    const logger = require("pino")({ level: "silent" });
    const sock = makeSocket({
      version,
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: Browsers?.ubuntu ? Browsers.ubuntu("Chrome") : undefined,
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    this.sock = sock;
    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", (update) => {
      void this.handleUpdate(lib, update);
    });
  }

  async handleUpdate(lib, update) {
    const { connection, lastDisconnect, qr } = update || {};

    if (qr) {
      this.state = "qr";
      this.qr = qr;
      this.qrRaw = qr;
      this.touch();
      try {
        const QRCode = require("qrcode");
        this.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
      } catch {
        this.qrDataUrl = null;
      }
      return;
    }

    if (connection === "open") {
      this.state = "connected";
      this.error = null;
      this.qr = null;
      this.qrRaw = null;
      this.qrDataUrl = null;
      this.attempts = 0;
      this.me = this.sock?.user?.id || this.sock?.user?.jid || null;
      this.touch();
      return;
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut =
        statusCode === lib.DisconnectReason?.loggedOut ||
        statusCode === 401;

      this.me = null;
      this.qr = null;
      this.qrRaw = null;
      this.qrDataUrl = null;
      this.sock = null;

      if (loggedOut) {
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        this.state = "disconnected";
        this.error = "La sesión de WhatsApp se cerró. Vuelve a escanear el QR.";
        this.touch();
        return;
      }

      this.attempts += 1;
      if (this.attempts > 5) {
        this.state = "error";
        this.error = "No se pudo reconectar con WhatsApp después de varios intentos.";
        this.touch();
        return;
      }

      this.state = "connecting";
      this.error = lastDisconnect?.error?.message || null;
      this.touch();
      const wait = Math.min(2000 * this.attempts, 15000);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        void this.connect();
      }, wait);
    }
  }

  async send(phone, text) {
    if (this.state !== "connected" || !this.sock) {
      throw new Error("WhatsApp no está conectado. Escanea el QR primero.");
    }

    const destino = normalizePhone(phone);
    if (!destino) throw new Error("El número de WhatsApp no es válido.");

    const jid = `${destino}@s.whatsapp.net`;
    const result = await this.sock.sendMessage(jid, { text: String(text || "") });
    return { ok: true, jid, id: result?.key?.id || null };
  }

  async sendDocument(phone, { content, filename, mimetype }) {
    if (this.state !== "connected" || !this.sock) {
      throw new Error("WhatsApp no está conectado. Escanea el QR primero.");
    }

    const destino = normalizePhone(phone);
    if (!destino) throw new Error("El número de WhatsApp no es válido.");
    if (!content || !content.length) throw new Error("El archivo adjunto está vacío.");

    const jid = `${destino}@s.whatsapp.net`;
    const result = await this.sock.sendMessage(jid, {
      document: content,
      fileName: filename || "adjunto",
      mimetype: mimetype || "application/octet-stream",
    });
    return { ok: true, jid, id: result?.key?.id || null };
  }

  async logout() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const sock = this.sock;
    this.sock = null;

    if (sock) {
      await sock.logout().catch(() => undefined);
      sock.end(new Error("Sesión cerrada."));
    }

    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    this.state = "disconnected";
    this.qr = null;
    this.qrRaw = null;
    this.qrDataUrl = null;
    this.me = null;
    this.error = null;
    this.attempts = 0;
    this.touch();
    return this.status();
  }
}

const manager = new WhatsAppManager();

module.exports = { WhatsAppManager, whatsapp: manager, AUTH_DIR };
