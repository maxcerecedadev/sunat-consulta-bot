import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Bell,
  Building2,
  Check,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Inbox,
  Loader2,
  MessageCircle,
  Paperclip,
  Pencil,
  Plus,
  QrCode,
  RefreshCcw,
  Send,
  Smartphone,
  Trash2,
  XCircle,
} from "lucide-react";

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
import { DateRangePicker, type DateRange } from "@/components/date-range-picker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface BuzonItem {
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

interface Empresa {
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

interface CheckResult {
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

interface BuzonJob {
  id: string;
  status: string;
  message: string;
  error: string | null;
  results: CheckResult[];
  logs: { at: string; message: string }[];
  startedAt: string;
  finishedAt: string | null;
}

interface WhatsAppStatus {
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

interface EmpresaForm {
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

const EMPTY_FORM: EmpresaForm = {
  nombre: "",
  ruc: "",
  usuario: "",
  clave: "",
  whatsapp: "",
  activo: true,
  autoEnviar: false,
  descargarAdjuntos: false,
};

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

export default function BuzonApp() {
  const [empresas, setEmpresas] = useState<Empresa[]>([]);
  const [whatsapp, setWhatsapp] = useState<WhatsAppStatus | null>(null);
  const [job, setJob] = useState<BuzonJob | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [filtro, setFiltro] = useState<"pendientes" | "todos">("pendientes");
  const [empresaFiltro, setEmpresaFiltro] = useState("all");
  const [rangoFechas, setRangoFechas] = useState<DateRange>({ from: undefined });

  const [empresaDialog, setEmpresaDialog] = useState(false);
  const [form, setForm] = useState<EmpresaForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [showClave, setShowClave] = useState(false);
  const [deleting, setDeleting] = useState<Empresa | null>(null);

  const [messageTarget, setMessageTarget] = useState<BuzonItem | null>(null);
  const [messageText, setMessageText] = useState("");
  const [sending, setSending] = useState(false);
  const [sendingItem, setSendingItem] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedLog, setCopiedLog] = useState(false);

  const waPoll = useRef<number | null>(null);

  const loadAll = useCallback(async () => {
    try {
      const [stateResponse, waResponse] = await Promise.all([
        fetch("/api/buzon/state"),
        fetch("/api/whatsapp/status"),
      ]);

      if (stateResponse.ok) {
        const data: { empresas: Empresa[] } = await stateResponse.json();
        setEmpresas(data.empresas || []);
      }

      if (waResponse.ok) {
        const data: WhatsAppStatus = await waResponse.json();
        setWhatsapp(data);
      }
    } catch {
      // La recarga es silenciosa; el usuario ve los errores de las acciones.
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (!jobId) return;

    let active = true;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/buzon/jobs/${encodeURIComponent(jobId)}`);
        if (!response.ok) throw new Error("No se pudo consultar la revisión.");
        const data: BuzonJob = await response.json();
        if (!active) return;

        setJob(data);

        if (["done", "error"].includes(data.status)) {
          window.clearInterval(timer);
          setChecking(false);
          if (data.status === "error") setError(data.error || data.message);
          void loadAll();
        }
      } catch (pollError) {
        if (!active) return;
        window.clearInterval(timer);
        setChecking(false);
        setError(pollError instanceof Error ? pollError.message : "Error de conexión.");
      }
    }, 1500);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [jobId, loadAll]);

  const startCheck = async (empresaId?: string) => {
    setError("");
    setNotice("");
    setChecking(true);

    try {
      const response = await fetch("/api/buzon/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(empresaId ? { empresaId } : {}),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "No se pudo iniciar la revisión.");
      if (!data.jobId) throw new Error("El servidor no devolvió el identificador de la revisión.");

      setJob({
        id: data.jobId,
        status: "running",
        message: "Revisando el Buzón SOL...",
        error: null,
        results: [],
        logs: [],
        startedAt: new Date().toISOString(),
        finishedAt: null,
      });
      setJobId(data.jobId);
    } catch (checkError) {
      setChecking(false);
      setError(checkError instanceof Error ? checkError.message : "Error de conexión.");
    }
  };

  const connectWhatsApp = async () => {
    setError("");
    try {
      await fetch("/api/whatsapp/connect", { method: "POST" });
      if (waPoll.current) window.clearInterval(waPoll.current);

      waPoll.current = window.setInterval(async () => {
        try {
          const response = await fetch("/api/whatsapp/status");
          if (!response.ok) return;
          const data: WhatsAppStatus = await response.json();
          setWhatsapp(data);
          if (["connected", "error", "disconnected", "unavailable"].includes(data.state)) {
            if (waPoll.current) window.clearInterval(waPoll.current);
            waPoll.current = null;
          }
        } catch {
          // Se reintenta en el siguiente ciclo.
        }
      }, 2000);
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : "Error de conexión.");
    }
  };

  useEffect(
    () => () => {
      if (waPoll.current) window.clearInterval(waPoll.current);
    },
    [],
  );

  const logoutWhatsApp = async () => {
    setError("");
    try {
      const response = await fetch("/api/whatsapp/logout", { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "No se pudo cerrar WhatsApp.");
      setWhatsapp(data);
    } catch (logoutError) {
      setError(logoutError instanceof Error ? logoutError.message : "Error de conexión.");
    }
  };

  const openCreate = () => {
    setForm(EMPTY_FORM);
    setShowClave(false);
    setEmpresaDialog(true);
  };

  const openEdit = (empresa: Empresa) => {
    setForm({
      id: empresa.id,
      nombre: empresa.nombre,
      ruc: empresa.ruc,
      usuario: empresa.usuario,
      clave: "",
      whatsapp: empresa.whatsapp,
      activo: empresa.activo,
      autoEnviar: empresa.autoEnviar,
      descargarAdjuntos: empresa.descargarAdjuntos,
    });
    setShowClave(false);
    setEmpresaDialog(true);
  };

  const saveEmpresa = async () => {
    setSaving(true);
    setError("");

    try {
      const method = form.id ? "PUT" : "POST";
      const url = form.id ? `/api/empresas/${encodeURIComponent(form.id)}` : "/api/empresas";
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "No se pudo guardar la empresa.");

      setEmpresaDialog(false);
      setNotice(form.id ? "Empresa actualizada." : "Empresa agregada.");
      await loadAll();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Error de conexión.");
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setError("");

    try {
      const response = await fetch(`/api/empresas/${encodeURIComponent(deleting.id)}`, {
        method: "DELETE",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "No se pudo eliminar la empresa.");
      setDeleting(null);
      setNotice("Empresa eliminada.");
      await loadAll();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Error de conexión.");
    }
  };

  const openMessage = (item: BuzonItem) => {
    setMessageTarget(item);
    setMessageText(item.mensaje);
    setCopied(false);
  };

  const copyMessage = async () => {
    try {
      await navigator.clipboard.writeText(messageText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("No se pudo copiar. Selecciona el texto y cópialo manualmente.");
    }
  };

  const copyJobLog = async () => {
    if (!job) return;
    const text = [
      job.message,
      ...job.logs.map((entry) => entry.message),
      job.error ? `Error: ${job.error}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    try {
      await navigator.clipboard.writeText(text);
      setCopiedLog(true);
      window.setTimeout(() => setCopiedLog(false), 1800);
    } catch {
      setError("No se pudo copiar. Selecciona el texto y cópialo manualmente.");
    }
  };

  const markSent = async (item: BuzonItem) => {
    try {
      const response = await fetch("/api/buzon/mark-sent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ruc: item.ruc, ids: [item.id] }),
      });
      if (!response.ok) throw new Error("No se pudo marcar como enviado.");
      setNotice("Marcado como enviado.");
      await loadAll();
    } catch (markError) {
      setError(markError instanceof Error ? markError.message : "Error de conexión.");
    }
  };

  const sendNow = async () => {
    if (!messageTarget) return;
    setSending(true);
    setError("");

    try {
      const response = await fetch("/api/buzon/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          empresaId: messageTarget.empresa_id,
          ids: [messageTarget.id],
          text: messageText,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "No se pudo enviar por WhatsApp.");

      setNotice(`Mensaje enviado a ${data.whatsapp}.`);
      setMessageTarget(null);
      await loadAll();
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Error de conexión.");
    } finally {
      setSending(false);
    }
  };

  const sendItemNow = async (item: BuzonItem) => {
    if (sendingItem) return;
    setSendingItem(`${item.empresa_id}-${item.id}`);
    setError("");
    setNotice("");

    try {
      const response = await fetch("/api/buzon/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          empresaId: item.empresa_id,
          ids: [item.id],
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "No se pudo enviar por WhatsApp.");

      setNotice(`Mensaje enviado a ${data.whatsapp}.`);
      await loadAll();
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Error de conexión.");
    } finally {
      setSendingItem(null);
    }
  };

  const allItems = useMemo(
    () => empresas.flatMap((empresa) => empresa.items || []),
    [empresas],
  );

  const items = useMemo(() => {
    const desde = rangoFechas.from
      ? new Date(
          rangoFechas.from.getFullYear(),
          rangoFechas.from.getMonth(),
          rangoFechas.from.getDate(),
        ).getTime()
      : null;
    const hasta = rangoFechas.to
      ? new Date(
          rangoFechas.to.getFullYear(),
          rangoFechas.to.getMonth(),
          rangoFechas.to.getDate(),
          23,
          59,
          59,
          999,
        ).getTime()
      : rangoFechas.from
        ? new Date(
            rangoFechas.from.getFullYear(),
            rangoFechas.from.getMonth(),
            rangoFechas.from.getDate(),
            23,
            59,
            59,
            999,
          ).getTime()
        : null;

    return allItems
      .filter((item) => (empresaFiltro === "all" ? true : item.empresa_id === empresaFiltro))
      .filter((item) => (filtro === "todos" ? true : !item.enviado))
      .filter((item) => {
        if (desde === null || hasta === null) return true;
        const fecha = itemDate(item);
        return fecha >= desde && fecha <= hasta;
      })
      .sort((a, b) => itemDate(b) - itemDate(a));
  }, [allItems, empresaFiltro, filtro, rangoFechas]);

  const pendientes = allItems.filter((item) => !item.enviado).length;
  const nuevos = allItems.filter((item) => item.nuevo && !item.enviado && !item.linea_base).length;
  const basePendientes = allItems.filter((item) => item.linea_base && !item.enviado).length;
  const whatsappListo = whatsapp?.state === "connected";

  const messagePhone = messageTarget
    ? empresas.find((empresa) => empresa.id === messageTarget.empresa_id)?.whatsapp || ""
    : "";
  const messageWaLink = messageTarget
    ? messagePhone
      ? `https://wa.me/${messagePhone}?text=${encodeURIComponent(messageText)}`
      : messageTarget.wa_link
    : null;

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="grid size-10 place-items-center rounded-xl bg-gradient-to-br from-primary to-secondary text-white shadow-lg shadow-primary/20">
              <Bell className="size-5" />
            </div>
            <div>
              <CardTitle>Buzón SOL</CardTitle>
              <CardDescription>
                Notificaciones y mensajes de todas tus empresas. Se leen solo los metadatos:
                SUNAT no marca nada como leído.
              </CardDescription>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={visible}
                onChange={(event) => setVisible(event.target.checked)}
                disabled={checking}
                className="size-4 accent-primary"
              />
              Mostrar navegador
            </label>
            <Button variant="outline" onClick={openCreate}>
              <Plus className="size-4" /> Agregar empresa
            </Button>
            <Button onClick={() => void startCheck()} disabled={checking || empresas.length === 0}>
              {checking ? <Loader2 className="size-4 animate-spin" /> : <RefreshCcw className="size-4" />}
              {checking ? "Revisando..." : "Revisar todas"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-2 text-sm text-muted-foreground sm:grid-cols-3">
            <span>
              Empresas activas: <strong className="text-foreground">{empresas.filter((e) => e.activo).length}</strong>
            </span>
            <span>
              Pendientes de enviar: <strong className="text-foreground">{pendientes}</strong>
            </span>
            <span>
              Novedades de la última revisión: <strong className="text-foreground">{nuevos}</strong>
            </span>
          </div>

          {basePendientes > 0 && (
            <p className="text-xs text-muted-foreground">
              Hay {basePendientes} registro(s) de la primera revisión (línea base) sin enviar.
              Aparecen en la lista como <strong>Pendientes</strong> para que los prepares o los
              marques como enviados.
            </p>
          )}

          {job && (
            <div className="rounded-xl border bg-muted/30 p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">{job.message}</span>
                <div className="flex items-center gap-2">
                  {job.logs.length > 0 && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void copyJobLog()}
                      className="h-7 gap-1.5 px-2.5 text-xs"
                    >
                      {copiedLog ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                      {copiedLog ? "Copiado" : "Copiar error"}
                    </Button>
                  )}
                  {job.status === "done" ? (
                    <Badge variant="outline" className="border-success/30 bg-success/10 text-success">
                      Completado
                    </Badge>
                  ) : job.status === "error" ? (
                    <Badge variant="outline" className="border-destructive/30 bg-destructive/10 text-destructive">
                      Error
                    </Badge>
                  ) : (
                    <Badge variant="outline">En curso</Badge>
                  )}
                </div>
              </div>
              {job.logs.length > 0 && (
                <details className="mt-2 text-xs text-muted-foreground">
                  <summary className="cursor-pointer">Ver registro</summary>
                  <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-slate-950 p-3 text-[11px] text-slate-300">
                    {job.logs.map((entry) => entry.message).join("\n")}
                  </pre>
                </details>
              )}
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-xl border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              <XCircle className="mt-0.5 size-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {notice && (
            <div className="flex items-start gap-2 rounded-xl border border-success/25 bg-success/5 px-4 py-3 text-sm text-success">
              <Check className="mt-0.5 size-4 shrink-0" />
              <span>{notice}</span>
            </div>
          )}
        </CardContent>
      </Card>

      <WhatsAppCard
        status={whatsapp}
        onConnect={() => void connectWhatsApp()}
        onLogout={() => void logoutWhatsApp()}
      />

      <Card className="overflow-hidden">
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 border-b">
          <div>
            <CardTitle>Empresas</CardTitle>
            <CardDescription>
              Las claves SOL se guardan cifradas en este equipo. No se envían a ningún servidor.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Empresa</TableHead>
                <TableHead>RUC</TableHead>
                <TableHead>Usuario</TableHead>
                <TableHead>WhatsApp</TableHead>
                <TableHead>Última revisión</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead className="text-right">Acciones</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {empresas.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
                    Agrega tu primera empresa para empezar a revisar el Buzón SOL.
                  </TableCell>
                </TableRow>
              )}
              {empresas.map((empresa) => (
                <TableRow key={empresa.id}>
                  <TableCell>
                    <div className="font-medium">{empresa.nombre}</div>
                    {(empresa.autoEnviar || empresa.descargarAdjuntos) && (
                      <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                        {empresa.autoEnviar && <span>Envío automático</span>}
                        {empresa.descargarAdjuntos && <span>Adjuntos y leído</span>}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>{empresa.ruc}</TableCell>
                  <TableCell>{empresa.usuario}</TableCell>
                  <TableCell>{empresa.whatsapp}</TableCell>
                  <TableCell>
                    {empresa.lastCheck
                      ? new Date(empresa.lastCheck).toLocaleString("es-PE", {
                          dateStyle: "short",
                          timeStyle: "short",
                        })
                      : "—"}
                    {empresa.lastError && (
                      <div className="text-[11px] text-destructive">{empresa.lastError}</div>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className={
                        empresa.activo
                          ? "border-success/30 bg-success/10 text-success"
                          : "border-border/60 bg-muted/50 text-muted-foreground"
                      }
                    >
                      {empresa.activo ? "Activa" : "Inactiva"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title="Revisar esta empresa"
                        onClick={() => void startCheck(empresa.id)}
                        disabled={checking || !empresa.activo}
                      >
                        <RefreshCcw className="size-4" />
                      </Button>
                      <Button variant="ghost" size="icon-sm" title="Editar" onClick={() => openEdit(empresa)}>
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        title="Eliminar"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setDeleting(empresa)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 border-b">
          <div>
            <CardTitle>Notificaciones y mensajes</CardTitle>
            <CardDescription>{items.length} registro(s) según el filtro.</CardDescription>
            <p className="mt-1 text-xs text-muted-foreground">
              <strong className="text-foreground">Preparar</strong>: edita el texto y elige
              WhatsApp Web o Baileys.{" "}
              <strong className="text-foreground">Enviar Baileys</strong>: envía al instante con la
              sesión vinculada.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <DateRangePicker
              value={rangoFechas}
              onChange={setRangoFechas}
              className="h-9 w-[220px] rounded-lg"
            />
            {rangoFechas.from && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-9 px-2 text-xs"
                onClick={() => setRangoFechas({ from: undefined })}
                title="Quitar filtro de fechas"
              >
                Limpiar
              </Button>
            )}
            <select
              value={empresaFiltro}
              onChange={(event) => setEmpresaFiltro(event.target.value)}
              className="h-9 rounded-lg border border-input bg-background px-2 text-sm"
            >
              <option value="all">Todas las empresas</option>
              {empresas.map((empresa) => (
                <option key={empresa.id} value={empresa.id}>
                  {empresa.nombre}
                </option>
              ))}
            </select>
            <div className="flex rounded-lg border p-0.5">
              <button
                type="button"
                className={`rounded-md px-3 py-1 text-xs font-medium ${
                  filtro === "pendientes" ? "bg-primary text-primary-foreground" : "text-muted-foreground"
                }`}
                onClick={() => setFiltro("pendientes")}
              >
                Pendientes
              </button>
              <button
                type="button"
                className={`rounded-md px-3 py-1 text-xs font-medium ${
                  filtro === "todos" ? "bg-primary text-primary-foreground" : "text-muted-foreground"
                }`}
                onClick={() => setFiltro("todos")}
              >
                Todos
              </button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Empresa</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Asunto</TableHead>
                <TableHead>Fecha</TableHead>
                <TableHead className="text-center">Adjuntos</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead className="text-right">WhatsApp</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-12 text-center text-muted-foreground">
                    <Inbox className="mx-auto mb-2 size-6" />
                    No hay registros. Revisa el buzón para cargar los metadatos.
                  </TableCell>
                </TableRow>
              )}
              {items.map((item) => (
                <TableRow key={`${item.ruc}-${item.id}`}>
                  <TableCell>
                    <div className="font-medium">{item.empresa_nombre}</div>
                    <div className="text-[11px] text-muted-foreground">{item.ruc}</div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">
                      {item.tipo === "notificacion" ? "Notificación" : "Mensaje"}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-[300px] whitespace-normal">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 font-medium leading-snug">{item.asunto}</span>
                      {item.urgente && (
                        <Badge variant="outline" className="border-destructive/30 bg-destructive/10 text-destructive">
                          Urgente
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>{formatDate(item.fecha_publicacion || item.fecha_envio)}</TableCell>
                  <TableCell className="text-center">
                    {item.archivos && item.archivos.length > 0 ? (
                      <a
                        href={item.archivos[0].url}
                        download
                        title={item.archivos.map((archivo) => archivo.nombre).join("\n")}
                        className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                      >
                        <Paperclip className="size-3.5" />
                        {item.archivos.length}/{item.adjuntos}
                      </a>
                    ) : item.adjuntos > 0 ? (
                      <a
                        href={item.buzon_link}
                        target="_blank"
                        rel="noreferrer"
                        title="Abrir el Buzón SOL para descargar los adjuntos"
                        className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                      >
                        <Paperclip className="size-3.5" />
                        {item.adjuntos}
                      </a>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {item.enviado ? (
                      <Badge variant="outline" className="border-success/30 bg-success/10 text-success">
                        Enviado
                      </Badge>
                    ) : item.nuevo ? (
                      <Badge variant="outline" className="border-primary/30 bg-primary/10 text-primary">
                        Nuevo
                      </Badge>
                    ) : item.linea_base ? (
                      <Badge variant="outline" className="text-muted-foreground">
                        Línea base
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-muted-foreground">
                        Pendiente
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-auto flex-col gap-0 px-3 py-1.5"
                        onClick={() => openMessage(item)}
                        title="Editar el mensaje y elegir WhatsApp Web (wa.me) o Baileys."
                      >
                        <span className="flex items-center gap-1.5">
                          <MessageCircle className="size-4" /> Preparar
                        </span>
                        <span className="text-[10px] font-normal leading-none text-muted-foreground">
                          Web / Baileys
                        </span>
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        className="h-auto flex-col gap-0 px-3 py-1.5"
                        onClick={() => void sendItemNow(item)}
                        disabled={
                          !whatsappListo ||
                          Boolean(sendingItem) ||
                          item.enviado ||
                          !item.mensaje.trim()
                        }
                        title={
                          !whatsappListo
                            ? "Conecta WhatsApp (Baileys) para enviar al instante."
                            : item.enviado
                              ? "Este mensaje ya fue enviado."
                              : "Enviar ahora con la sesión vinculada (Baileys), sin abrir WhatsApp Web."
                        }
                      >
                        <span className="flex items-center gap-1.5">
                          {sendingItem === `${item.empresa_id}-${item.id}` ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <Send className="size-4" />
                          )}
                          Enviar
                        </span>
                        <span className="text-[10px] font-medium leading-none text-white/80">
                          Baileys
                        </span>
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={empresaDialog} onOpenChange={setEmpresaDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Building2 className="size-5 text-primary" />
              {form.id ? "Editar empresa" : "Agregar empresa"}
            </DialogTitle>
            <DialogDescription>
              La clave SOL se guarda cifrada en este equipo. Si es multiempresa, agrega una por RUC.
            </DialogDescription>
            <p className="text-xs text-muted-foreground">
              Los campos con <span className="font-semibold text-destructive">*</span> son
              obligatorios.
            </p>
          </DialogHeader>
          <div className="grid gap-4">
            <Field label="Nombre">
              <Input
                value={form.nombre}
                onChange={(event) => setForm({ ...form, nombre: event.target.value })}
                placeholder="Empresa SAC"
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="RUC" required>
                <Input
                  value={form.ruc}
                  maxLength={11}
                  onChange={(event) =>
                    setForm({ ...form, ruc: event.target.value.replace(/\D/g, "") })
                  }
                  placeholder="20123456789"
                />
              </Field>
              <Field label="Usuario SOL" required>
                <Input
                  value={form.usuario}
                  onChange={(event) => setForm({ ...form, usuario: event.target.value })}
                  placeholder="MIUSUARIO"
                />
              </Field>
            </div>
            <Field
              label={form.id ? "Clave SOL (dejar vacío para conservar)" : "Clave SOL"}
              required={!form.id}
            >
              <div className="relative">
                <Input
                  type={showClave ? "text" : "password"}
                  value={form.clave}
                  onChange={(event) => setForm({ ...form, clave: event.target.value })}
                  placeholder={form.id ? "••••••••" : "Clave SOL"}
                  autoComplete="new-password"
                  className="pr-11"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setShowClave((current) => !current)}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground"
                  aria-label={showClave ? "Ocultar clave" : "Mostrar clave"}
                >
                  {showClave ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </Button>
              </div>
            </Field>
            <Field label="WhatsApp (con código de país)" required>
              <Input
                value={form.whatsapp}
                onChange={(event) => setForm({ ...form, whatsapp: event.target.value })}
                placeholder="51987654321"
              />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.activo}
                onChange={(event) => setForm({ ...form, activo: event.target.checked })}
                className="size-4 accent-primary"
              />
              Empresa activa
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.autoEnviar}
                onChange={(event) => setForm({ ...form, autoEnviar: event.target.checked })}
                className="mt-0.5 size-4 accent-primary"
              />
              <span>
                Enviar automáticamente las novedades con Baileys.
                <span className="block text-xs text-muted-foreground">
                  Requiere la sesión de WhatsApp vinculada y BUZON_AUTO=true en el servidor (o el
                  CLI con --enviar). Puede ser considerado spam por WhatsApp.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.descargarAdjuntos}
                onChange={(event) =>
                  setForm({ ...form, descargarAdjuntos: event.target.checked })
                }
                className="mt-0.5 size-4 accent-primary"
              />
              <span>
                Descargar adjuntos y marcar como leído.
                <span className="block text-xs text-muted-foreground">
                  Abre el detalle en SUNAT y marca el mensaje como leído de forma
                  irreversible. Los PDFs quedan en este equipo y se envían con Baileys junto al
                  texto.
                </span>
              </span>
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEmpresaDialog(false)} disabled={saving}>
              Cancelar
            </Button>
            <Button onClick={() => void saveEmpresa()} disabled={saving}>
              {saving && <Loader2 className="size-4 animate-spin" />}
              {saving ? "Guardando..." : "Guardar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(messageTarget)}
        onOpenChange={(open) => {
          if (!open && !sending) setMessageTarget(null);
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MessageCircle className="size-5 text-primary" />
              Preparar mensaje
            </DialogTitle>
            <DialogDescription>
              {messageTarget
                ? `${messageTarget.empresa_nombre} · ${messageTarget.tipo_label} · ${messageTarget.asunto}`
                : ""}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3">
            <Label className="text-[10.5px] font-bold uppercase tracking-wider text-muted-foreground">
              Texto del mensaje
            </Label>
            <textarea
              value={messageText}
              onChange={(event) => setMessageText(event.target.value)}
              rows={10}
              className="w-full rounded-xl border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />

            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => void copyMessage()}>
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                {copied ? "Copiado" : "Copiar texto"}
              </Button>
              {messageWaLink && (
                <Button asChild variant="outline" size="sm">
                  <a href={messageWaLink} target="_blank" rel="noreferrer">
                    <ExternalLink className="size-4" /> Abrir WhatsApp Web
                  </a>
                </Button>
              )}
              {messageTarget?.buzon_link && (
                <Button asChild variant="outline" size="sm">
                  <a href={messageTarget.buzon_link} target="_blank" rel="noreferrer">
                    <ExternalLink className="size-4" /> Ver en el Buzón
                  </a>
                </Button>
              )}
              {messageTarget && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void markSent(messageTarget)}
                >
                  <Check className="size-4" /> Marcar enviado
                </Button>
              )}
            </div>

            {messageTarget && messageTarget.adjuntos > 0 && (
              <p className="text-xs text-muted-foreground">
                Este mensaje tiene {messageTarget.adjuntos} adjunto(s).{" "}
                {messageTarget.archivos && messageTarget.archivos.length > 0
                  ? "Ya están descargados y se enviarán como archivos con Baileys."
                  : "Descárgalos desde el Buzón SOL o habilita la descarga antes de revisar."}
              </p>
            )}

            {messageTarget?.archivos && messageTarget.archivos.length > 0 && (
              <div className="grid gap-1 rounded-xl border bg-muted/30 p-3">
                <span className="text-[10.5px] font-bold uppercase tracking-wider text-muted-foreground">
                  Adjuntos descargados
                </span>
                {messageTarget.archivos.map((archivo) => (
                  <a
                    key={archivo.nombre}
                    href={archivo.url}
                    download={archivo.nombre}
                    className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                  >
                    <Paperclip className="size-3.5" />
                    {archivo.nombre}
                  </a>
                ))}
              </div>
            )}

            {messageTarget?.adjuntos_error && (
              <p className="text-xs text-destructive">{messageTarget.adjuntos_error}</p>
            )}

            {messageTarget?.adjuntos_nota && (
              <p className="text-xs text-amber-700 dark:text-amber-300">{messageTarget.adjuntos_nota}</p>
            )}

            <div className="grid gap-3 rounded-xl border bg-muted/30 p-3 text-xs text-muted-foreground sm:grid-cols-2">
              <div className="grid gap-1">
                <span className="flex items-center gap-1.5 font-semibold text-foreground">
                  <ExternalLink className="size-3.5" /> WhatsApp Web (wa.me)
                </span>
                <p>
                  Abre WhatsApp con el texto listo y tú confirmas el envío. No requiere sesión
                  vinculada.
                </p>
              </div>
              <div className="grid gap-1">
                <span className="flex items-center gap-1.5 font-semibold text-foreground">
                  <Send className="size-3.5" /> Baileys (sesión vinculada)
                </span>
                <p>
                  Envía al instante desde el número conectado. Se marca como enviado y no se puede
                  deshacer.
                </p>
              </div>
            </div>

            {!whatsappListo && (
              <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span>
                  Para enviar con Baileys conecta la sesión de WhatsApp en el panel de arriba. Si no,
                  usa “Abrir WhatsApp Web” y el mensaje se abrirá listo para enviar manualmente.
                </span>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setMessageTarget(null)} disabled={sending}>
              Cerrar
            </Button>
            <Button
              variant="secondary"
              onClick={() => void sendNow()}
              disabled={sending || !whatsappListo}
              title={
                whatsappListo
                  ? "Envía ahora con la sesión vinculada (Baileys)."
                  : "Conecta la sesión de WhatsApp para enviar con Baileys."
              }
            >
              {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
              {sending ? "Enviando..." : "Enviar con Baileys"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(deleting)} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Eliminar empresa</DialogTitle>
            <DialogDescription>
              ¿Eliminar {deleting?.nombre || deleting?.ruc}? Se borran sus credenciales guardadas.
              El historial del buzón se conserva en este equipo.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              Cancelar
            </Button>
            <Button variant="destructive" onClick={() => void confirmDelete()}>
              Eliminar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function WhatsAppCard({
  status,
  onConnect,
  onLogout,
}: {
  status: WhatsAppStatus | null;
  onConnect: () => void;
  onLogout: () => void;
}) {
  const state = status?.state || "disconnected";
  const connected = state === "connected";

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="grid size-10 place-items-center rounded-xl bg-emerald-500/10 text-emerald-600">
            <Smartphone className="size-5" />
          </div>
          <div>
            <CardTitle>Sesión de WhatsApp (Baileys)</CardTitle>
            <CardDescription>
              Vincula un número para enviar al instante con Baileys. El enlace wa.me (WhatsApp Web)
              funciona sin conectar nada.
            </CardDescription>
          </div>
        </div>
        <Badge
          variant="outline"
          className={
            connected
              ? "border-success/30 bg-success/10 text-success"
              : state === "error" || state === "unavailable"
                ? "border-destructive/30 bg-destructive/10 text-destructive"
                : ""
          }
        >
          {stateLabel(state)}
        </Badge>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            {status?.warning ||
              "La sesión de WhatsApp Web (Baileys) no es oficial. El número podría ser bloqueado si envías demasiados mensajes."}
          </span>
        </div>

        {status?.error && (
          <div className="rounded-xl border border-destructive/25 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {status.error}
          </div>
        )}

        {status?.qr && (
          <div className="grid justify-items-center gap-2 rounded-xl border bg-white p-4">
            <img src={status.qr} alt="QR de WhatsApp" className="size-64" />
            <p className="text-sm text-slate-600">
              WhatsApp &gt; Dispositivos vinculados &gt; Vincular un dispositivo
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {!connected && (
            <Button onClick={onConnect} disabled={status?.available === false}>
              <QrCode className="size-4" /> Conectar WhatsApp
            </Button>
          )}
          {connected && (
            <span className="text-sm text-muted-foreground">
              Conectado como {status?.me || "tu número"}
            </span>
          )}
          <Button variant="outline" onClick={onLogout} disabled={state === "disconnected"}>
            Cerrar sesión
          </Button>
        </div>

        {status?.available === false && (
          <p className="text-xs text-muted-foreground">
            Instala las dependencias con <code>npm install @whiskeysockets/baileys qrcode</code>.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-2">
      <Label className="text-[10.5px] font-bold uppercase tracking-wider text-muted-foreground">
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
      </Label>
      {children}
    </div>
  );
}
