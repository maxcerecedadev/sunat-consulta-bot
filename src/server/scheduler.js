"use strict";

require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { exec, execFile } = require("child_process");
const { ZipArchive } = require("archiver");
const {
  SunatClient,
  TIPOS,
  TIPO_LABELS,
  DOCUMENTOS,
  TIPOS_RECIBIDOS,
  tipoLabel,
} = require("../sunat-client");
const { parseUbl } = require("../ubl");
const { parseDate } = require("../dates");
const { ensureDir, safeName, sleep } = require("../util");
const {
  readEmpresas,
  getEmpresa,
  createEmpresa,
  updateEmpresa,
  deleteEmpresa,
} = require("../empresas");
const {
  checkAll,
  checkEmpresa,
  getPreparedItems,
  decorateItems,
  sendPrepared,
  attachmentFile,
} = require("../buzon-service");
const { readAllState, markSent } = require("../buzon-store");
const { whatsapp } = require("../whatsapp-baileys");
const {
  writeJson,
  writeCsv,
  summarizeJob,
  buildRows,
  VOUCHER_COLUMNS,
  ITEM_COLUMNS,
} = require("../exporters");


const { buzonJobs } = require("./state");

function startBuzonScheduler() {
  if (process.env.BUZON_AUTO !== "true") return;

  const minutes = Math.max(Number(process.env.BUZON_INTERVAL_MIN || 15), 1);
  let busy = false;

  const check = async () => {
    if (busy) return;
    busy = true;

    try {
      const empresas = readEmpresas({ withSecrets: true }).filter(
        (empresa) => empresa.activo,
      );

      for (const empresa of empresas) {
        try {
          const automatico =
            empresa.autoEnviar && whatsapp.status().state === "connected";
          const result = await checkEmpresa(empresa, {
            enviar: automatico,
            soloNuevos: true,
            log: (message) => console.log(`[buzón] ${message}`),
          });
          if (result.newCount > 0) {
            console.log(
              `[buzón] ${empresa.ruc}: ${result.newCount} novedad(es)` +
                (automatico ? `, enviadas: ${result.enviados.length}` : ""),
            );
          }
        } catch (error) {
          console.error(`[buzón] ${empresa.ruc}: ${error.message}`);
        }
      }
    } finally {
      busy = false;
    }
  };

  setTimeout(check, 20000);
  setInterval(check, minutes * 60 * 1000);
  console.log(`Revisión automática del Buzón cada ${minutes} minuto(s).`);
}

startBuzonScheduler();


module.exports = { startBuzonScheduler };
