"use strict";

const fs = require("fs");
const path = require("path");

const { app, UI_DIR } = require("./state");

/**
 * La UI es una SPA de Vite. Cualquier ruta que no sea /api devuelve index.html.
 */
function spaFallback(req, res, next) {
  if (req.path.startsWith("/api/")) return next();

  const indexFile = path.join(UI_DIR, "index.html");
  if (!fs.existsSync(indexFile)) {
    return res
      .status(503)
      .send("La UI no está compilada. Ejecuta: npm run build:ui (o npm run ui).");
  }

  res.sendFile(indexFile);
}

app.get("*", spaFallback);

module.exports = { spaFallback };
