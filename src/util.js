"use strict";

const fs = require("fs");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeName(invoice) {
  return `${invoice.tipo}-${invoice.serie}-${invoice.numero}`.replace(/[^0-9A-Za-z-]/g, "_");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { ensureDir, safeName, sleep };
