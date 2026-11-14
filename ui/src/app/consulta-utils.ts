import {
  PREF_KEY,
  TIPO_DOCUMENTO_LABELS,
  type DateRange,
  type HistoryItem,
  type Invoice,
  type Job,
  type Prefs,
} from "./consulta-types";

function readPrefs(): Prefs {
  try {
    return JSON.parse(localStorage.getItem(PREF_KEY) || "{}") as Prefs;
  } catch {
    return {};
  }
}

function parseLocalDate(value?: string): Date | undefined {
  if (!value) return undefined;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return undefined;
  return new Date(year, month - 1, day);
}

function toISODate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

function defaultRange(): DateRange {
  const now = new Date();
  return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: now };
}

function invoiceTypeLabel(invoice: Invoice): string {
  const code = invoice.detail?.tipo || invoice.tipo;
  return TIPO_DOCUMENTO_LABELS[code] || invoice.tipo_label || code || "Comprobante";
}

function money(value: number | null | undefined, currency?: string | null): string {
  if (value === null || value === undefined) return "—";
  return new Intl.NumberFormat("es-PE", {
    style: "currency",
    currency: String(currency || "").toUpperCase() === "USD" ? "USD" : "PEN",
    minimumFractionDigits: 2,
  }).format(Number(value));
}

function fileUrl(jobId: string, filePath?: string): string | null {
  if (!filePath) return null;
  const [section, ...rest] = filePath.split("/");
  return `/api/jobs/${jobId}/files/${section}/${encodeURIComponent(rest.join("/"))}`;
}

function exportUrl(jobId: string, name: string): string {
  return `/api/jobs/${jobId}/export/${name}`;
}

function statusTitle(status: string): string {
  return (
    {
      queued: "En cola",
      login: "Iniciando sesión en SUNAT",
      listing: "Consultando SUNAT",
      processing: "Procesando comprobantes",
      done: "Consulta completada",
      cancelled: "Consulta cancelada",
      error: "Error en la consulta",
    }[status] || "Procesando"
  );
}

function progressPercent(job: Job): number {
  if (job.status === "done") return 100;
  if (job.status === "cancelled") {
    return Math.min(100, Math.round((job.processed / Math.max(job.total, 1)) * 100));
  }
  if (job.total > 0) return Math.round((job.processed / job.total) * 100);
  if (job.status === "processing") return 25;
  if (job.status === "listing") return 18;
  if (job.status === "login") return 8;
  return 2;
}


function historyStatus(item: HistoryItem) {
    if (item.status === "error") {
      return {
        label: "Error",
        className: "border-destructive/30 bg-destructive/10 text-destructive",
      };
    }

    if (item.status === "cancelled") {
      return {
        label: "Cancelada",
        className: "border-border/70 bg-muted/40 text-muted-foreground",
      };
    }

    if (item.status === "interrupted") {
      return {
        label: "Interrumpida",
        className: "border-border/70 bg-muted/40 text-muted-foreground",
      };
    }

    if (["queued", "login", "listing", "processing"].includes(item.status)) {
      return { label: "En proceso", className: "" };
    }

    if (item.stats?.soloListar) {
      return {
        label: "Solo listado",
        className: "border-border/70 bg-muted/40 text-muted-foreground",
      };
    }

    if (item.stats && item.stats.total === 0) {
      return {
        label: "Sin comprobantes",
        className: "border-border/70 bg-muted/40 text-muted-foreground",
      };
    }

    if (item.stats && item.stats.withFiles === 0) {
      return {
        label: "Sin archivos",
        className: "border-destructive/30 bg-destructive/10 text-destructive",
      };
    }

    if (item.stats && item.stats.errors > 0) {
      return {
        label: item.stats.withFiles > 0 ? "Con errores" : "Error",
        className: "border-destructive/30 bg-destructive/10 text-destructive",
      };
    }

    return {
      label: "Completada",
      className: "border-success/30 bg-success/10 text-success",
    };
  };


export {
  readPrefs,
  parseLocalDate,
  toISODate,
  defaultRange,
  invoiceTypeLabel,
  money,
  fileUrl,
  exportUrl,
  statusTitle,
  progressPercent,
  historyStatus,
};
