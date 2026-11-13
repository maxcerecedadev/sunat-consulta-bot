"use strict";

const { app, PORT, HOST, DATA_DIR } = require("./server/state");
const { openBrowser, loadHistory } = require("./server/helpers");
const { startBuzonScheduler } = require("./server/scheduler");

require("./server/routes-core");
require("./server/routes-buzon");
require("./server/routes-jobs");

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();

  const indexFile = path.join(UI_DIR, "index.html");
  if (!fs.existsSync(indexFile)) {
    return res
      .status(503)
      .send("La UI no está compilada. Ejecuta: npm run build:ui (o npm run ui).");
  }

  res.sendFile(indexFile);
});


loadHistory();
startBuzonScheduler();

const server = app.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`\nConsulta SUNAT UI: ${url}`);
  console.log("Cierra esta ventana (Ctrl+C) para detener el servidor.\n");
  openBrowser(url);
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`\nEl puerto ${PORT} ya está en uso.`);
    console.error("Cierra la instancia anterior o usa otro puerto:");
    console.error(`  UI_PORT=3132 npm run ui\n`);
    console.error(`Para encontrar el proceso: ss -ltnp | grep ${PORT}\n`);
    process.exit(1);
  }

  throw error;});
