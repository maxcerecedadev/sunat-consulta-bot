"use strict";

const { app, BrowserWindow, dialog, shell } = require("electron");
const { spawn } = require("child_process");
const http = require("http");
const net = require("net");
const path = require("path");

let serverProcess = null;
let mainWindow = null;
let quitting = false;

function findFreePort(startPort) {
  return new Promise((resolve, reject) => {
    const tryPort = (port) => {
      if (port > 65535) {
        reject(new Error("No hay un puerto libre disponible."));
        return;
      }

      const tester = net.createServer();
      tester.unref();
      tester.once("error", () => tryPort(port + 1));
      tester.once("listening", () => {
        const { port: freePort } = tester.address();
        tester.close(() => resolve(freePort));
      });
      tester.listen(port, "127.0.0.1");
    };

    tryPort(startPort);
  });
}

function waitForServer(port, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };

    const attempt = () => {
      const request = http.get(
        { host: "127.0.0.1", port, path: "/api/config", timeout: 1200 },
        (response) => {
          response.resume();
          if (response.statusCode === 200) {
            finish();
          } else if (Date.now() - started > timeoutMs) {
            finish(new Error("El servidor local no respondió a tiempo."));
          } else {
            setTimeout(attempt, 300);
          }
        },
      );

      request.on("timeout", () => {
        request.destroy();
        if (Date.now() - started > timeoutMs) finish(new Error("Tiempo de espera agotado."));
        else setTimeout(attempt, 300);
      });

      request.on("error", () => {
        if (Date.now() - started > timeoutMs) finish(new Error("No se pudo iniciar el servidor local."));
        else setTimeout(attempt, 300);
      });
    };

    attempt();
  });
}

function startServer(port) {
  const serverPath = path.join(__dirname, "..", "src", "server.js");

  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    UI_PORT: String(port),
    UI_OPEN: "false",
    SUNAT_DATA_DIR: app.getPath("userData"),
    SUNAT_UI_DIR: app.isPackaged
      ? path.join(process.resourcesPath, "ui-dist")
      : path.join(__dirname, "..", "ui-dist"),
  };

  if (app.isPackaged) {
    env.PLAYWRIGHT_BROWSERS_PATH = path.join(process.resourcesPath, "playwright-browsers");
  }

  serverProcess = spawn(process.execPath, [serverPath], {
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  serverProcess.stdout.on("data", (data) => {
    console.log(`[server] ${String(data).trim()}`);
  });

  serverProcess.stderr.on("data", (data) => {
    console.error(`[server] ${String(data).trim()}`);
  });

  serverProcess.on("exit", (code) => {
    if (!quitting && code !== 0) {
      dialog.showErrorBox(
        "Consulta SUNAT",
        "El motor local se cerró inesperadamente. Revisa que el puerto esté libre e intenta de nuevo.",
      );
    }
  });
}

function stopServer() {
  if (!serverProcess) return;

  const pid = serverProcess.pid;
  serverProcess = null;

  if (!pid) return;

  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // El proceso ya terminó.
    }
  }
}

async function createWindow() {
  const port = await findFreePort(3131);
  startServer(port);
  await waitForServer(port);

  mainWindow = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 980,
    minHeight: 700,
    title: "Consulta SUNAT",
    backgroundColor: "#f5f7fb",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) && !url.includes("127.0.0.1")) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  await mainWindow.loadURL(`http://127.0.0.1:${port}`);
}

app.whenReady().then(createWindow).catch((error) => {
  dialog.showErrorBox("Consulta SUNAT", error.message);
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow().catch((error) => dialog.showErrorBox("Consulta SUNAT", error.message));
  }
});

app.on("window-all-closed", () => {
  quitting = true;
  stopServer();
  app.quit();
});

app.on("before-quit", () => {
  quitting = true;
  stopServer();
});
