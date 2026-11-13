import type { DateRange } from "@/components/date-range-picker";

export const PREF_KEY = "sunat-consulta-prefs";
export const ACTIVE_JOB_KEY = "sunat-active-job";

export interface InvoiceItem {
  line: string;
  code: string | null;
  description: string | null;
  quantity: number;
  unit: string | null;
  unit_value: number;
  line_total: number;
  igv: number;
}

export interface Detail {
  tipo: string;
  serie: string | null;
  numero: string | null;
  fecha: string | null;
  hora: string | null;
  moneda: string | null;
  emisor: { doc_type: string | null; doc_number: string | null; name: string | null };
  cliente: { doc_type: string | null; doc_number: string | null; name: string | null };
  totals: {
    gravado: number;
    igv: number;
    total: number;
    descuentos: number;
    otros_cargos: number;
  };
  items: InvoiceItem[];
}

export interface Invoice {
  id: string;
  tipo: string;
  tipo_label: string;
  serie: string;
  numero: string;
  numero_desc: string;
  fecha: string;
  ruc_emisor: string;
  emisor: string;
  ruc_receptor: string;
  receptor: string;
  total: number | null;
  moneda: string;
  estado: string;
  detail: Detail | null;
  files: { xml?: string; pdf?: string; cdr?: string };
  error: string | null;
}

export interface JobStats {
  soloListar: boolean;
  total: number;
  withFiles: number;
  xml: number;
  pdf: number;
  cdr: number;
  files: number;
  errors: number;
  sinArchivos: number;
  cdrFaltantes: number;
}

export interface Job {
  id: string;
  status: string;
  message: string;
  error: string | null;
  total: number;
  processed: number;
  cancelled: boolean;
  invoices: Invoice[];
  logs: { at: string; message: string }[];
  options: {
    ruc: string;
    user: string;
    tipo: string;
    documento: string;
    desde: string;
    hasta: string;
    soloListar: boolean;
    descargarXml: boolean;
    descargarPdf: boolean;
  };
  stats?: JobStats;
  hasFiles?: boolean;
  createdAt: string;
  hasOutput: boolean;
}

export interface HistoryItem {
  id: string;
  createdAt: string;
  status: string;
  message: string;
  total: number;
  processed: number;
  options: Job["options"];
  stats?: JobStats;
  hasFiles?: boolean;
  hasOutput: boolean;
}

export interface Prefs {
  ruc?: string;
  user?: string;
  desde?: string;
  hasta?: string;
  documento?: string;
  tipo?: string;
  pdf?: boolean;
  max?: string;
}


export const TIPO_DOCUMENTO_LABELS: Record<string, string> = {
  "01": "Factura",
  "03": "Boleta",
  "07": "Nota de crédito",
  "08": "Nota de débito",
};


export type { DateRange };
