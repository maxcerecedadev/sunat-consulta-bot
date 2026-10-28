"use strict";

const BUZON_LINK =
  process.env.SUNAT_BUZON_LINK ||
  "https://e-menu.sunat.gob.pe/cl-ti-itmenu/MenuInternet.htm?action=buzon&s=ww1";

function normalizePhone(value) {
  let digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 9 && digits.startsWith("9")) digits = `51${digits}`;
  return digits.slice(0, 15);
}

function buildMessage(empresa, item) {
  const tipo = item.tipo === "mensaje" ? "Mensaje" : "Notificación";
  const fecha = item.fecha_publicacion || item.fecha_envio || "";
  const lineas = [
    `Buzón SUNAT - ${tipo}`,
    `Empresa: ${empresa.nombre || empresa.ruc}`,
    `RUC: ${empresa.ruc}`,
    `Asunto: ${item.asunto || "(sin asunto)"}`,
  ];

  if (fecha) lineas.push(`Fecha: ${fecha}`);
  if (item.urgente) lineas.push("Marcado como urgente por SUNAT.");
  if (item.adjuntos > 0) lineas.push(`Adjuntos: ${item.adjuntos}`);
  lineas.push("", `Revisa tu Buzón SOL: ${BUZON_LINK}`);

  return lineas.join("\n");
}

function waLink(phone, text) {
  const destino = normalizePhone(phone);
  if (!destino) return null;
  return `https://wa.me/${destino}?text=${encodeURIComponent(text)}`;
}

module.exports = { BUZON_LINK, normalizePhone, buildMessage, waLink };
