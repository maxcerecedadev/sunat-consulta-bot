import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { DateRange } from "@/components/date-range-picker";
import { BuzonControlCard, EmpresasCard, NotificacionesCard } from "./buzon/BuzonCards";
import { BuzonDialogs } from "./buzon/BuzonDialogs";
import { WhatsAppCard } from "./buzon/BuzonWhatsAppCard";
import {
  EMPTY_FORM,
  type BuzonController,
  type BuzonItem,
  type BuzonJob,
  type Empresa,
  type EmpresaForm,
  type WhatsAppStatus,
} from "./buzon/buzon-types";
import { itemDate } from "./buzon/buzon-utils";

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

  const controller: BuzonController = {
    empresas,
    whatsapp,
    job,
    checking,
    visible,
    setVisible,
    error,
    notice,
    filtro,
    setFiltro,
    empresaFiltro,
    setEmpresaFiltro,
    rangoFechas,
    setRangoFechas,
    empresaDialog,
    setEmpresaDialog,
    form,
    setForm,
    saving,
    showClave,
    setShowClave,
    deleting,
    setDeleting,
    messageTarget,
    setMessageTarget,
    messageText,
    setMessageText,
    sending,
    sendingItem,
    copied,
    copiedLog,
    items,
    pendientes,
    nuevos,
    basePendientes,
    whatsappListo,
    messageWaLink,
    startCheck,
    connectWhatsApp,
    logoutWhatsApp,
    openCreate,
    openEdit,
    saveEmpresa,
    confirmDelete,
    openMessage,
    copyMessage,
    copyJobLog,
    markSent,
    sendNow,
    sendItemNow,
  };

  return (
    <div className="grid gap-6">
      <BuzonControlCard {...controller} />
      <WhatsAppCard
        status={whatsapp}
        onConnect={() => void connectWhatsApp()}
        onLogout={() => void logoutWhatsApp()}
      />
      <EmpresasCard {...controller} />
      <NotificacionesCard {...controller} />
      <BuzonDialogs {...controller} />
    </div>
  );
}
