"use strict";

const path = require("path");
const { execSync } = require("child_process");

// Instala Chromium en una carpeta del proyecto para incluirla en el paquete.
// Debe ejecutarse en Windows si el instalador es para Windows.
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, "..", "playwright-browsers");

execSync("npx playwright install chromium", {
  stdio: "inherit",
  env: process.env,
  shell: true,
});
