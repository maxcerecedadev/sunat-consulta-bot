"use strict";

function parseDate(input, label) {
  const value = String(input || "").trim();
  let match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  let year;
  let month;
  let day;

  if (match) {
    [, year, month, day] = match;
  } else {
    match = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!match) {
      throw new Error(`${label} inválida. Usa YYYY-MM-DD o DD/MM/YYYY.`);
    }
    [, day, month, year] = match;
  }

  const date = new Date(Number(year), Number(month) - 1, Number(day));
  if (
    date.getFullYear() !== Number(year) ||
    date.getMonth() !== Number(month) - 1 ||
    date.getDate() !== Number(day)
  ) {
    throw new Error(`${label} inválida.`);
  }

  return {
    iso: `${year}-${month}-${day}`,
    sunat: `${day}/${month}/${year}`,
  };
}

function firstDayOfMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}

function today() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate(),
  ).padStart(2, "0")}`;
}

module.exports = { parseDate, firstDayOfMonth, today };
