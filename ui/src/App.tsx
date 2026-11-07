import { useCallback, useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { es } from "date-fns/locale";
import {
  AlertCircle,
  Bell,
  Check,
  CloudDownload,
  Copy,
  Eye,
  EyeOff,
  FileCode2,
  FileText,
  Loader2,
  RefreshCcw,
  Search,
  Trash2,
} from "lucide-react";

import packageInfo from "../../package.json";
import BuzonApp from "./BuzonApp";

import { DateRangePicker, type DateRange } from "@/components/date-range-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

const PREF_KEY = "sunat-consulta-prefs";
const ACTIVE_JOB_KEY = "sunat-active-job";

interface InvoiceItem {
  line: string;
  code: string | null;
  description: string | null;
  quantity: number;
  unit: string | null;
  unit_value: number;
  line_total: number;
  igv: number;
}

interface Detail {
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

interface Invoice {
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

interface Job {
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
  createdAt: string;
  hasOutput: boolean;
}

interface HistoryItem {
  id: string;
  createdAt: string;
  status: string;
  message: string;
  total: number;
  processed: number;
  options: Job["options"];
  hasOutput: boolean;
}

interface Prefs {
  ruc?: string;
  user?: string;
  desde?: string;
  hasta?: string;
  documento?: string;
  tipo?: string;
  pdf?: boolean;
  solo?: boolean;
  max?: string;
}

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

const TIPO_DOCUMENTO_LABELS: Record<string, string> = {
  "01": "Factura",
  "03": "Boleta",
  "07": "Nota de crédito",
  "08": "Nota de débito",
};

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

export default function App() {
  const [view, setView] = useState<"comprobantes" | "buzon">("comprobantes");
  const prefs = useMemo(readPrefs, []);
  const initialRange = useMemo(() => {
    const from = parseLocalDate(prefs.desde);
    const to = parseLocalDate(prefs.hasta);
    return {
      from: from ?? defaultRange().from,
      to: to ?? new Date(),
    };
  }, [prefs]);

  const [ruc, setRuc] = useState(prefs.ruc ?? "");
  const [user, setUser] = useState(prefs.user ?? "");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [documento, setDocumento] = useState(prefs.documento ?? "factura");
  const [tipo, setTipo] = useState(prefs.tipo ?? "10");
  const [range, setRange] = useState<DateRange>(initialRange);
  const [downloadPdf, setDownloadPdf] = useState(prefs.pdf !== false);
  const [soloListar, setSoloListar] = useState(Boolean(prefs.solo));
  const [visible, setVisible] = useState(false);
  const [max, setMax] = useState(prefs.max ?? "");

  const [documentos, setDocumentos] = useState<Record<string, string>>({
    factura: "Facturas",
    boleta: "Boletas",
  });
  const [tipos, setTipos] = useState<Record<string, string>>({
    "10": "Facturas emitidas",
    "11": "Facturas recibidas",
    "12": "Facturas rechazadas",
    "13": "Notas de crédito emitidas",
    "14": "Notas de crédito recibidas",
    "15": "Notas de débito emitidas",
    "16": "Notas de débito recibidas",
  });

  const [job, setJob] = useState<Job | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [detailRecord, setDetailRecord] = useState<Invoice | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyTotalPages, setHistoryTotalPages] = useState(1);
  const [deleteTarget, setDeleteTarget] = useState<HistoryItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadHistory = useCallback(async (page = 1) => {
    try {
      const response = await fetch(`/api/history?page=${page}&pageSize=20`);
      if (!response.ok) return;
      const data: {
        items: HistoryItem[];
        total: number;
        page: number;
        pageSize: number;
        totalPages: number;
      } = await response.json();
      setHistory(data.items);
      setHistoryPage(data.page);
      setHistoryTotal(data.total);
      setHistoryTotalPages(data.totalPages);
    } catch {
      // El historial es opcional.
    }
  }, []);

  useEffect(() => {
    void loadHistory(1);
  }, [loadHistory]);

  useEffect(() => {
    const saved = localStorage.getItem(ACTIVE_JOB_KEY);
    if (saved) setJobId(saved);
  }, []);

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);

    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(deleteTarget.id)}`, {
        method: "DELETE",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "No se pudo eliminar la consulta.");
      }

      if (job?.id === deleteTarget.id) {
        setJob(null);
        setJobId(null);
      }

      setDeleteTarget(null);
      await loadHistory(historyPage);
    } catch (deleteError) {
      setError(
        deleteError instanceof Error ? deleteError.message : "No se pudo eliminar la consulta.",
      );
    } finally {
      setDeleting(false);
    }
  };

  useEffect(() => {
    fetch("/api/config")
      .then((response) => response.json())
      .then((config) => {
        setRuc((current) => current || config.ruc || "");
        setUser((current) => current || config.user || "");
      })
      .catch(() => undefined);

    fetch("/api/documentos")
      .then((response) => response.json())
      .then((data) => setDocumentos(data))
      .catch(() => undefined);

    fetch("/api/tipos")
      .then((response) => response.json())
      .then((data) => setTipos(data))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!jobId) return;

    let active = true;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`);
        if (!response.ok) {
          if (response.status === 404) {
            localStorage.removeItem(ACTIVE_JOB_KEY);
            setJobId(null);
            setJob(null);
            return;
          }
          throw new Error("No se pudo consultar el estado del proceso.");
        }

        const data: Job = await response.json();
        if (!active) return;

        setJob(data);

        if (["done", "error", "cancelled"].includes(data.status)) {
          window.clearInterval(timer);
          localStorage.removeItem(ACTIVE_JOB_KEY);
          if (data.status === "error") {
            setError(data.error || "La consulta terminó con error.");
          }
          void loadHistory(1);
        }
      } catch (pollError) {
        if (!active) return;
        window.clearInterval(timer);
        setError(pollError instanceof Error ? pollError.message : "Error de conexión.");
      }
    }, 1200);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [jobId, loadHistory]);

  const running = Boolean(
    job && ["queued", "login", "listing", "processing"].includes(job.status),
  );

  const tipoOptions = Object.entries(tipos).map(([value, label]) => ({
    value,
    label: documento === "boleta" ? label.replace(/^Facturas/, "Boletas") : label,
  }));

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");

    if (!/^\d{11}$/.test(ruc)) {
      setError("El RUC debe tener 11 dígitos.");
      return;
    }
    if (!user.trim()) {
      setError("Ingresa el usuario SOL.");
      return;
    }
    if (!password) {
      setError("Ingresa la clave SOL.");
      return;
    }
    if (!range.from) {
      setError("Selecciona el periodo de consulta.");
      return;
    }

    const desde = range.from;
    const hasta = range.to ?? range.from;
    if (desde > hasta) {
      setError("La fecha inicial no puede ser mayor que la final.");
      return;
    }

    const payload = {
      ruc: ruc.trim(),
      user: user.trim(),
      password,
      desde: toISODate(desde),
      hasta: toISODate(hasta),
      documento,
      tipo,
      descargarPdf: downloadPdf,
      soloListar,
      visible,
      max: max ? Number(max) : null,
    };

    localStorage.setItem(
      PREF_KEY,
      JSON.stringify({
        ruc: payload.ruc,
        user: payload.user,
        desde: payload.desde,
        hasta: payload.hasta,
        documento: payload.documento,
        tipo: payload.tipo,
        pdf: payload.descargarPdf,
        solo: payload.soloListar,
        max: max || undefined,
      }),
    );

    setJobId(null);
    setCancelling(false);
    setJob({
      id: "",
      status: "queued",
      message: "Enviando consulta...",
      error: null,
      total: 0,
      processed: 0,
      cancelled: false,
      invoices: [],
      logs: [],
      options: {
        ruc: payload.ruc,
        user: payload.user,
        tipo: payload.tipo,
        documento: payload.documento,
        desde: payload.desde,
        hasta: payload.hasta,
        soloListar: payload.soloListar,
        descargarXml: !payload.soloListar,
        descargarPdf: payload.descargarPdf,
      },
      createdAt: new Date().toISOString(),
      hasOutput: false,
    });

    try {
      const response = await fetch("/api/consulta", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "No se pudo iniciar la consulta.");
      localStorage.setItem(ACTIVE_JOB_KEY, data.jobId);
      setJobId(data.jobId);
    } catch (submitError) {
      setJob(null);
      setError(submitError instanceof Error ? submitError.message : "Error de conexión.");
    }
  };

  const cancelJob = async (id: string) => {
    await fetch(`/api/jobs/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
    }).catch(() => undefined);
    await loadHistory(historyPage);
  };

  const handleCancel = async () => {
    if (!jobId) return;
    setCancelling(true);
    await cancelJob(jobId);
    localStorage.removeItem(ACTIVE_JOB_KEY);
    setCancelling(false);
  };

  const historyTypeLabel = (item: HistoryItem) => {
    const code = item.options?.tipo || "10";
    const label = tipos[code] || code;
    return item.options?.documento === "boleta"
      ? label.replace(/^Facturas/, "Boletas")
      : label;
  };

  const historyStatusLabel = (status: string) =>
    status === "done"
      ? "Completada"
      : status === "error"
        ? "Error"
        : status === "cancelled"
          ? "Cancelada"
          : "En proceso";

  const historyStatusClass = (status: string) =>
    status === "done"
      ? "border-success/30 bg-success/10 text-success"
      : status === "error"
        ? "border-destructive/30 bg-destructive/10 text-destructive"
        : "";

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-border/60 bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="grid size-10 place-items-center rounded-xl bg-gradient-to-br from-primary to-secondary text-white shadow-lg shadow-primary/25">
              <CloudDownload className="size-5" />
            </div>
            <div>
              <h1 className="text-lg font-semibold tracking-tight">Consulta SUNAT</h1>
              <p className="text-xs text-muted-foreground">
                Comprobantes, Buzón SOL y WhatsApp
              </p>
            </div>
          </div>
          <nav className="flex items-center gap-1 rounded-xl border border-border/70 bg-muted/40 p-1">
            <Button
              variant={view === "comprobantes" ? "default" : "ghost"}
              size="sm"
              onClick={() => setView("comprobantes")}
            >
              <CloudDownload className="size-4" />
              Comprobantes
            </Button>
            <Button
              variant={view === "buzon" ? "default" : "ghost"}
              size="sm"
              onClick={() => setView("buzon")}
            >
              <Bell className="size-4" />
              Buzón SOL
            </Button>
          </nav>
          <Badge variant="outline" className="border-border/70 bg-muted/40 text-muted-foreground">
            v{packageInfo.version}
          </Badge>
        </div>
      </header>

      {view === "comprobantes" ? (
      <main className="mx-auto grid max-w-6xl gap-6 px-6 py-8">
        <Card>
          <CardHeader>
            <CardTitle>Nueva consulta</CardTitle>
            <CardDescription>
              Se conecta al portal de SUNAT con tu Clave SOL. La clave no se guarda.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="grid gap-5">
              <div className="grid gap-4 md:grid-cols-3">
                <Field label="RUC">
                  <Input
                    value={ruc}
                    onChange={(event) => setRuc(event.target.value.replace(/\D/g, ""))}
                    maxLength={11}
                    placeholder="20123456789"
                    disabled={running}
                    className="h-10"
                  />
                </Field>

                <Field label="Usuario SOL">
                  <Input
                    value={user}
                    onChange={(event) => setUser(event.target.value)}
                    placeholder="Usuario"
                    autoComplete="username"
                    disabled={running}
                    className="h-10"
                  />
                </Field>

                <Field label="Clave SOL">
                  <div className="relative">
                    <Input
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      placeholder="Clave SOL"
                      autoComplete="current-password"
                      disabled={running}
                      className="h-10 pr-11"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setShowPassword((current) => !current)}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground"
                      aria-label={showPassword ? "Ocultar clave" : "Mostrar clave"}
                    >
                      {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                    </Button>
                  </div>
                </Field>

                <Field label="Documento">
                  <Select value={documento} onValueChange={setDocumento} disabled={running}>
                    <SelectTrigger className="h-10 w-full rounded-xl">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(documentos).map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>

                <Field label="Tipo">
                  <Select value={tipo} onValueChange={setTipo} disabled={running}>
                    <SelectTrigger className="h-10 w-full rounded-xl">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {tipoOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.value} - {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>

                <Field label="Periodo">
                  <DateRangePicker value={range} onChange={setRange} className="h-10" />
                </Field>

                {["11", "14", "16"].includes(tipo) && (
                  <p className="text-xs text-muted-foreground md:col-span-3">
                    Recibidas: se consultan por SIRE RCE y el periodo debe ser un solo mes.
                  </p>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-dashed pt-4">
                <Checkbox
                  checked={downloadPdf}
                  onChange={setDownloadPdf}
                  label="Descargar PDF"
                  disabled={running}
                />
                <Checkbox
                  checked={soloListar}
                  onChange={setSoloListar}
                  label="Solo listar (sin XML)"
                  disabled={running}
                />
                <Checkbox
                  checked={visible}
                  onChange={setVisible}
                  label="Mostrar navegador"
                  disabled={running}
                />
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">Máx. comprobantes</span>
                  <Input
                    type="number"
                    min={1}
                    value={max}
                    onChange={(event) => setMax(event.target.value)}
                    placeholder="todos"
                    disabled={running}
                    className="h-9 w-28"
                  />
                </div>
              </div>

              <div className="flex flex-wrap gap-3">
                <Button type="submit" disabled={running} className="min-w-40">
                  {running ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Search className="size-4" />
                  )}
                  {running ? "Consultando..." : "Consultar SUNAT"}
                </Button>
                {running && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleCancel}
                    disabled={cancelling}
                  >
                    {cancelling ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <RefreshCcw className="size-4" />
                    )}
                    {cancelling ? "Cancelando..." : "Cancelar"}
                  </Button>
                )}
              </div>
            </form>
          </CardContent>
        </Card>

        {error && (
          <div className="flex items-start gap-3 overflow-hidden rounded-xl border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span className="min-w-0 max-w-full flex-1 break-words">{error}</span>
          </div>
        )}

        {job && <StatusCard job={job} />}

        {job && (job.invoices.length > 0 || ["done", "error", "cancelled"].includes(job.status)) && (
          <ResultsCard job={job} onDetail={setDetailRecord} />
        )}

        {history.length > 0 && (
          <Card className="overflow-hidden">
            <CardHeader className="border-b">
              <CardTitle>Historial</CardTitle>
              <CardDescription>
                Consultas guardadas en este equipo. Puedes abrirlas, descargarlas o eliminarlas.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Fecha</TableHead>
                    <TableHead>RUC</TableHead>
                    <TableHead>Tipo</TableHead>
                    <TableHead>Periodo</TableHead>
                    <TableHead>Comprobantes</TableHead>
                    <TableHead>Estado</TableHead>
                    <TableHead className="text-center">Acciones</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {history.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell>
                        {new Date(item.createdAt).toLocaleString("es-PE", {
                          dateStyle: "short",
                          timeStyle: "short",
                        })}
                      </TableCell>
                      <TableCell>{item.options?.ruc || "—"}</TableCell>
                      <TableCell>{historyTypeLabel(item)}</TableCell>
                      <TableCell>
                        {item.options?.desde || "—"} → {item.options?.hasta || "—"}
                      </TableCell>
                      <TableCell>
                        {item.processed}/{item.total}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={historyStatusClass(item.status)}
                        >
                          {historyStatusLabel(item.status)}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap justify-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            title="Abrir consulta"
                            onClick={() => {
                              setError("");
                              setJobId(item.id);
                              window.scrollTo({ top: 0, behavior: "smooth" });
                            }}
                          >
                            <Eye className="size-4" />
                          </Button>
                          {["queued", "login", "listing", "processing"].includes(
                            item.status,
                          ) && (
                            <Button
                              variant="outline"
                              size="sm"
                              title="Cancelar consulta"
                              className="text-destructive hover:text-destructive"
                              onClick={() => void cancelJob(item.id)}
                            >
                              Cancelar
                            </Button>
                          )}
                          {item.hasOutput && (
                            <Button asChild variant="outline" size="sm">
                              <a href={`/api/jobs/${item.id}/zip`} download>
                                ZIP
                              </a>
                            </Button>
                          )}
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setDeleteTarget(item)}
                            aria-label="Eliminar consulta"
                            className="text-destructive hover:text-destructive"
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-sm">
                <span className="text-muted-foreground">
                  {historyTotal} consulta(s)
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={historyPage <= 1}
                    onClick={() => void loadHistory(historyPage - 1)}
                  >
                    Anterior
                  </Button>
                  <span className="text-muted-foreground">
                    Página {historyPage} de {historyTotalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={historyPage >= historyTotalPages}
                    onClick={() => void loadHistory(historyPage + 1)}
                  >
                    Siguiente
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </main>
      ) : (
        <main className="mx-auto grid max-w-6xl gap-6 px-6 py-8">
          <BuzonApp />
        </main>
      )}

      <Dialog open={Boolean(detailRecord)} onOpenChange={(open) => !open && setDetailRecord(null)}>
        <DialogContent className="max-h-[88vh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CloudDownload className="size-5 text-primary" />
              Detalle del comprobante
            </DialogTitle>
            <DialogDescription>
              {detailRecord
                ? `${invoiceTypeLabel(detailRecord)} ${detailRecord.serie}-${detailRecord.numero}`
                : ""}
            </DialogDescription>
          </DialogHeader>
          {detailRecord && <DetailBody record={detailRecord} jobId={job?.id || jobId || ""} />}
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteTarget(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Eliminar consulta</DialogTitle>
            <DialogDescription>
              ¿Eliminar la consulta del{" "}
              {deleteTarget
                ? new Date(deleteTarget.createdAt).toLocaleString("es-PE", {
                    dateStyle: "short",
                    timeStyle: "short",
                  })
                : ""}
              ? Se borrarán el XML, PDF y CDR descargados. Esta acción no se puede deshacer.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={deleting}
            >
              Cancelar
            </Button>
            <Button
              variant="destructive"
              onClick={() => void confirmDelete()}
              disabled={deleting}
            >
              {deleting ? "Eliminando..." : "Eliminar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-2">
      <Label className="text-[10.5px] font-bold uppercase tracking-wider text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

function Checkbox({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        disabled={disabled}
        className="size-4 rounded border-input accent-primary"
      />
      {label}
    </label>
  );
}

function StatusCard({ job }: { job: Job }) {
  const percent = progressPercent(job);
  const [copied, setCopied] = useState(false);

  const copyLog = async () => {
    const text = [
      job.message,
      ...job.logs.map((entry) => entry.message),
      job.error ? `Error: ${job.error}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      document.body.removeChild(area);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    }
  };

  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="grid gap-1">
            <p className="font-semibold">{statusTitle(job.status)}</p>
            <p className="break-words text-sm text-muted-foreground">{job.message}</p>
          </div>
          <span className="text-sm text-muted-foreground">
            {job.total > 0 ? `${job.processed} / ${job.total}` : job.status === "done" ? "Listo" : ""}
          </span>
        </div>

        <div className="mt-4 h-2 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-gradient-to-r from-primary to-secondary transition-all duration-300"
            style={{ width: `${percent}%` }}
          />
        </div>

        {job.logs.length > 0 && (
          <div className="mt-3 flex items-start justify-between gap-2">
            <details className="min-w-0 flex-1 text-xs text-muted-foreground">
              <summary className="cursor-pointer font-medium text-foreground/70">
                Ver registro
              </summary>
              <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-950 p-3 text-[11px] leading-relaxed text-slate-300">
                {job.logs.map((entry) => entry.message).join("\n")}
              </pre>
            </details>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void copyLog()}
              className="shrink-0 gap-1.5 text-xs"
            >
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              {copied ? "Copiado" : job.status === "error" ? "Copiar error" : "Copiar registro"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ResultsCard({
  job,
  onDetail,
}: {
  job: Job;
  onDetail: (invoice: Invoice) => void;
}) {
  const isReceived = ["11", "14", "16"].includes(job.options.tipo);

  const exports = job.hasOutput ? (
    <div className="flex flex-wrap gap-4 text-sm">
      <a
        className="font-semibold text-primary hover:underline"
        href={exportUrl(job.id, "comprobantes.csv")}
        download
      >
        Descargar CSV
      </a>
      <a
        className="font-semibold text-primary hover:underline"
        href={exportUrl(job.id, "comprobantes.json")}
        download
      >
        Descargar JSON
      </a>
      <a
        className="font-semibold text-primary hover:underline"
        href={`/api/jobs/${job.id}/zip`}
        download
      >
        Descargar todo (ZIP)
      </a>
    </div>
  ) : null;

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-row items-start justify-between gap-4 border-b">
        <div>
          <CardTitle>Resultados</CardTitle>
          <CardDescription>{job.invoices.length} comprobante(s) encontrado(s)</CardDescription>
        </div>
        {exports}
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Comprobante</TableHead>
              <TableHead>Tipo</TableHead>
              <TableHead>Fecha</TableHead>
              <TableHead>Emisor / Receptor</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead>Estado</TableHead>
              <TableHead className="text-right">Acciones</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {job.invoices.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-12 text-center text-muted-foreground">
                  SUNAT no devolvió comprobantes para este rango.
                </TableCell>
              </TableRow>
            )}

            {job.invoices.map((invoice) => {
              const detail = invoice.detail;
              const hasDetail = Boolean(detail?.items?.length);
              const xml = fileUrl(job.id, invoice.files?.xml);
              const pdf = fileUrl(job.id, invoice.files?.pdf);
              const cdr = fileUrl(job.id, invoice.files?.cdr);
              const typeLabel = invoiceTypeLabel(invoice);
              const party = isReceived
                ? {
                    name: detail?.emisor.name || invoice.emisor || "—",
                    doc: detail?.emisor.doc_number || invoice.ruc_emisor || "—",
                  }
                : {
                    name: detail?.cliente.name || invoice.receptor || invoice.emisor || "—",
                    doc:
                      detail?.cliente.doc_number ||
                      invoice.ruc_receptor ||
                      invoice.ruc_emisor ||
                      "—",
                  };
              const total = detail?.totals.total ?? invoice.total;
              const currency = detail?.moneda || invoice.moneda;
              const rawEstado = String(invoice.estado || "").trim();
              const estado =
                rawEstado === "1"
                  ? "Aceptado"
                  : rawEstado === "2"
                    ? "Anulado"
                    : rawEstado || (detail ? "Aceptado" : "—");
              const status = String(estado).toLowerCase();
              const statusClass = status.includes("acept")
                ? "border-success/30 bg-success/10 text-success"
                : status.includes("rechaz")
                  ? "border-destructive/30 bg-destructive/10 text-destructive"
                  : "";

              return (
                <TableRow key={`${invoice.id}-${invoice.serie}-${invoice.numero}`}>
                  <TableCell>
                    <div className="flex items-center gap-1.5 font-semibold">
                      {invoice.numero_desc}
                      {invoice.error && (
                        <span
                          title={invoice.error}
                          className="inline-block size-1.5 rounded-full bg-destructive"
                        />
                      )}
                    </div>
                    {invoice.detail && (
                      <span className="text-[11.5px] text-muted-foreground">
                        {invoice.detail.items.length} ítem(s)
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{typeLabel}</Badge>
                  </TableCell>
                  <TableCell>{invoice.fecha || detail?.fecha || "—"}</TableCell>
                  <TableCell>
                    <div className="font-medium">{party.name}</div>
                    <div className="text-[11.5px] text-muted-foreground">{party.doc}</div>
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {money(total, currency)}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={statusClass}>
                      {estado}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      {hasDetail && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          title="Ver detalle"
                          onClick={() => onDetail(invoice)}
                        >
                          <Eye className="size-4" />
                        </Button>
                      )}
                      {xml && (
                        <Button asChild variant="ghost" size="icon-sm" title="Descargar XML">
                          <a href={xml} download>
                            <FileCode2 className="size-4" />
                          </a>
                        </Button>
                      )}
                      {pdf && (
                        <Button asChild variant="ghost" size="icon-sm" title="Descargar PDF">
                          <a href={pdf} download>
                            <FileText className="size-4" />
                          </a>
                        </Button>
                      )}
                      {cdr && (
                        <Button asChild variant="ghost" size="icon-sm" title="Descargar CDR">
                          <a href={cdr} download>
                            <FileText className="size-4" />
                          </a>
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function DetailBody({ record, jobId }: { record: Invoice; jobId: string }) {
  const detail = record.detail;
  if (!detail) {
    return <p className="text-sm text-muted-foreground">No se pudo leer el detalle del XML.</p>;
  }

  const xml = fileUrl(jobId, record.files?.xml);
  const pdf = fileUrl(jobId, record.files?.pdf);
  const cdr = fileUrl(jobId, record.files?.cdr);

  return (
    <div className="grid gap-5">
      <div className="grid gap-3 rounded-xl border bg-muted/30 p-4 text-sm sm:grid-cols-2">
        <div>
          <p className="text-[10.5px] font-bold uppercase tracking-wider text-muted-foreground">
            Emisor
          </p>
          <p className="font-semibold">{detail.emisor.name || record.emisor || "—"}</p>
          <p className="text-muted-foreground">{detail.emisor.doc_number || record.ruc_emisor}</p>
        </div>
        <div>
          <p className="text-[10.5px] font-bold uppercase tracking-wider text-muted-foreground">
            Cliente
          </p>
          <p className="font-semibold">{detail.cliente.name || record.receptor || "—"}</p>
          <p className="text-muted-foreground">
            {detail.cliente.doc_number || record.ruc_receptor}
          </p>
        </div>
        <div>
          <p className="text-[10.5px] font-bold uppercase tracking-wider text-muted-foreground">
            Emisión
          </p>
          <p className="font-semibold">
            {detail.fecha || record.fecha || "—"} {detail.hora || ""}
          </p>
        </div>
        <div>
          <p className="text-[10.5px] font-bold uppercase tracking-wider text-muted-foreground">
            Moneda
          </p>
          <p className="font-semibold">{detail.moneda || record.moneda || "—"}</p>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>#</TableHead>
              <TableHead>Descripción</TableHead>
              <TableHead>Código</TableHead>
              <TableHead className="text-right">Cant.</TableHead>
              <TableHead className="text-right">V. Unit.</TableHead>
              <TableHead className="text-right">Total línea</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {detail.items.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                  El XML no contiene líneas de detalle.
                </TableCell>
              </TableRow>
            )}
            {detail.items.map((item) => (
              <TableRow key={`${item.line}-${item.code ?? item.description}`}>
                <TableCell>{item.line}</TableCell>
                <TableCell className="max-w-[320px]">{item.description || "—"}</TableCell>
                <TableCell>{item.code || "—"}</TableCell>
                <TableCell className="text-right">
                  {item.quantity} {item.unit || ""}
                </TableCell>
                <TableCell className="text-right">
                  {money(item.unit_value, detail.moneda)}
                </TableCell>
                <TableCell className="text-right">
                  {money(item.line_total, detail.moneda)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="ml-auto grid w-full max-w-xs gap-1.5 text-sm">
        <div className="flex justify-between gap-8 text-muted-foreground">
          <span>Gravado</span>
          <span>{money(detail.totals.gravado, detail.moneda)}</span>
        </div>
        <div className="flex justify-between gap-8 text-muted-foreground">
          <span>IGV</span>
          <span>{money(detail.totals.igv, detail.moneda)}</span>
        </div>
        <div className="flex justify-between gap-8 border-t pt-1.5 text-base font-bold">
          <span>Total</span>
          <span>{money(detail.totals.total, detail.moneda)}</span>
        </div>
      </div>

      {record.error && <p className="break-words text-xs text-destructive">{record.error}</p>}

      <div className="flex flex-wrap justify-end gap-2">
        {xml && (
          <Button asChild variant="outline">
            <a href={xml} download>
              <FileCode2 className="size-4" />
              XML
            </a>
          </Button>
        )}
        {pdf && (
          <Button asChild variant="outline">
            <a href={pdf} download>
              <FileText className="size-4" />
              PDF
            </a>
          </Button>
        )}
        {cdr && (
          <Button asChild variant="outline">
            <a href={cdr} download>
              <FileText className="size-4" />
              CDR
            </a>
          </Button>
        )}
      </div>
    </div>
  );
}
