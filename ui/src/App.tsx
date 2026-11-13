import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, CloudDownload } from "lucide-react";

import BuzonApp from "./BuzonApp";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ACTIVE_JOB_KEY,
  PREF_KEY,
  type DateRange,
  type HistoryItem,
  type Invoice,
  type Job,
} from "./app/consulta-types";
import {
  defaultRange,
  invoiceTypeLabel,
  parseLocalDate,
  readPrefs,
  toISODate,
} from "./app/consulta-utils";
import { AppHeader, type Vista } from "./app/AppHeader";
import { ConsultaForm } from "./app/ConsultaForm";
import { HistoryCard } from "./app/HistoryCard";
import { DetailBody } from "./app/consulta-detail";
import { ResultsCard, StatusCard } from "./app/consulta-widgets";

export default function App() {
  const [view, setView] = useState<Vista>("comprobantes");
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
  // "Solo listar" es una opción de una sola corrida: si se guardara, una
  // consulta posterior podría terminar sin XML/PDF/CDR sin que el usuario lo
  // note. Siempre se inicia desmarcada.
  const [soloListar, setSoloListar] = useState(false);
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

  const openJobFolder = async (id: string) => {
    try {
      const response = await fetch(
        `/api/jobs/${encodeURIComponent(id)}/open-folder`,
        { method: "POST" },
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "No se pudo abrir la carpeta de la consulta.");
      }
    } catch (openError) {
      setError(
        openError instanceof Error
          ? openError.message
          : "No se pudo abrir la carpeta de la consulta.",
      );
    }
  };

  return (
    <div className="min-h-screen">
      <AppHeader view={view} onChange={setView} />

      {view === "comprobantes" ? (
        <main className="mx-auto grid max-w-6xl gap-6 px-6 py-8">
          <ConsultaForm
            ruc={ruc}
            setRuc={setRuc}
            user={user}
            setUser={setUser}
            password={password}
            setPassword={setPassword}
            showPassword={showPassword}
            setShowPassword={setShowPassword}
            documento={documento}
            setDocumento={setDocumento}
            documentos={documentos}
            tipo={tipo}
            setTipo={setTipo}
            tipoOptions={tipoOptions}
            range={range}
            setRange={setRange}
            downloadPdf={downloadPdf}
            setDownloadPdf={setDownloadPdf}
            soloListar={soloListar}
            setSoloListar={setSoloListar}
            visible={visible}
            setVisible={setVisible}
            max={max}
            setMax={setMax}
            running={running}
            cancelling={cancelling}
            onSubmit={handleSubmit}
            onCancel={handleCancel}
          />

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

          <HistoryCard
            history={history}
            page={historyPage}
            total={historyTotal}
            totalPages={historyTotalPages}
            tipos={tipos}
            onLoadHistory={loadHistory}
            onOpen={(id) => {
              setError("");
              setJobId(id);
              window.scrollTo({ top: 0, behavior: "smooth" });
            }}
            onOpenFolder={openJobFolder}
            onCancel={cancelJob}
            onDelete={setDeleteTarget}
          />
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
