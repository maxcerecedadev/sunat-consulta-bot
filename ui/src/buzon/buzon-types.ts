import type { DateRange } from "@/components/date-range-picker";

export interface BuzonItem {
  id: string;
  codigo: string;
  tipo: string;
  tipo_label: string;
  asunto: string;
  fecha_envio: string;
  fecha_publicacion: string;
  fecha_vigencia: string;
  urgente: boolean;
  adjuntos: number;
  estado_codigo: string;
  carpeta: string;
  etiqueta: string;
  empresa_id: string;
  empresa_nombre: string;
  ruc: string;
  nuevo: boolean;
  linea_base?: boolean;
  detectado_en: string;
  enviado: boolean;
  enviado_en: string | null;
  mensaje: string;
  wa_link: string | null;
  buzon_link?: string;
  leido?: boolean;
  adjuntos_descargados?: boolean;
  adjuntos_error?: string | null;
  adjuntos_nota?: string | null;
  archivos?: {
    nombre: string;
    cod_archivo?: number;
    tamano?: number;
    mime?: string;
    url: string;
  }[];
}

export interface Empresa {
  id: string;
  nombre: string;
  ruc: string;
  usuario: string;
  whatsapp: string;
  activo: boolean;
  autoEnviar: boolean;
  descargarAdjuntos: boolean;
  tieneClave: boolean;
  creado?: string | null;
  actualizado?: string | null;
  lastCheck?: string | null;
  lastError?: string | null;
  baseline?: boolean;
  items?: BuzonItem[];
  error?: string;
}

export interface CheckResult {
  empresa?: { id: string; nombre: string; ruc: string; whatsapp: string };
  baseline?: boolean;
  total?: number;
  newCount?: number;
  newItems?: BuzonItem[];
  items?: BuzonItem[];
  enviados?: string[];
  sendError?: string | null;
  error?: string;
}

export interface BuzonJob {
  id: string;
  status: string;
  message: string;
  error: string | null;
  results: CheckResult[];
  logs: { at: string; message: string }[];
  startedAt: string;
  finishedAt: string | null;
}

export interface WhatsAppStatus {
  available: boolean;
  state: string;
  qr: string | null;
  rawQr: string | null;
  me: string | null;
  error: string | null;
  lastUpdate: string;
  authDir: string;
  warning: string;
}

export interface EmpresaForm {
  id?: string;
  nombre: string;
  ruc: string;
  usuario: string;
  clave: string;
  whatsapp: string;
  activo: boolean;
  autoEnviar: boolean;
  descargarAdjuntos: boolean;
}

export const EMPTY_FORM: EmpresaForm = {
  nombre: "",
  ruc: "",
  usuario: "",
  clave: "",
  whatsapp: "",
  activo: true,
  autoEnviar: false,
  descargarAdjuntos: false,
};


export interface BuzonController {
  empresas: Empresa[];
  whatsapp: WhatsAppStatus | null;
  job: BuzonJob | null;
  checking: boolean;
  visible: boolean;
  setVisible: (value: boolean) => void;
  error: string;
  notice: string;
  filtro: "pendientes" | "todos";
  setFiltro: (value: "pendientes" | "todos") => void;
  empresaFiltro: string;
  setEmpresaFiltro: (value: string) => void;
  rangoFechas: DateRange;
  setRangoFechas: (value: DateRange) => void;
  empresaDialog: boolean;
  setEmpresaDialog: (value: boolean) => void;
  form: EmpresaForm;
  setForm: (value: EmpresaForm) => void;
  saving: boolean;
  showClave: boolean;
  setShowClave: (value: boolean) => void;
  deleting: Empresa | null;
  setDeleting: (value: Empresa | null) => void;
  messageTarget: BuzonItem | null;
  setMessageTarget: (value: BuzonItem | null) => void;
  messageText: string;
  setMessageText: (value: string) => void;
  sending: boolean;
  sendingItem: string | null;
  copied: boolean;
  copiedLog: boolean;
  items: BuzonItem[];
  pendientes: number;
  nuevos: number;
  basePendientes: number;
  whatsappListo: boolean;
  messageWaLink: string | null;
  startCheck: (empresaId?: string) => Promise<void>;
  connectWhatsApp: () => Promise<void>;
  logoutWhatsApp: () => Promise<void>;
  openCreate: () => void;
  openEdit: (empresa: Empresa) => void;
  saveEmpresa: () => Promise<void>;
  confirmDelete: () => Promise<void>;
  openMessage: (item: BuzonItem) => void;
  copyMessage: () => Promise<void>;
  copyJobLog: () => Promise<void>;
  markSent: (item: BuzonItem) => Promise<void>;
  sendNow: () => Promise<void>;
  sendItemNow: (item: BuzonItem) => Promise<void>;
}

export interface EmpresaFormState {}
