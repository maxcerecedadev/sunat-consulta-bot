import type { BuzonItem } from "./buzon-types";

function formatDate(value: string): string {
  if (!value) return "—";
  return value;
}

function parseFecha(value: string): number {
  const text = (value || "").trim();
  if (!text) return 0;

  const sunat = text.match(
    /^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/,
  );
  if (sunat) {
    const [, day, month, year, hour = "0", minute = "0", second = "0"] = sunat;
    return new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    ).getTime();
  }

  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function itemDate(item: BuzonItem): number {
  return parseFecha(item.fecha_publicacion || item.fecha_envio);
}

function stateLabel(state: string): string {
  return (
    {
      connected: "Conectado",
      connecting: "Conectando",
      qr: "Esperando QR",
      disconnected: "Desconectado",
      unavailable: "No disponible",
      error: "Error",
    }[state] || state
  );
}


export { formatDate, parseFecha, itemDate, stateLabel };
