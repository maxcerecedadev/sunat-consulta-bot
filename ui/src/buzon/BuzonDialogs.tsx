import {
  AlertTriangle,
  Building2,
  Check,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Loader2,
  MessageCircle,
  Send,
  Paperclip,
  Smartphone,
  Trash2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import type { BuzonController } from "./buzon-types";

export function BuzonDialogs(controller: BuzonController) {
  const {
    empresaDialog, setEmpresaDialog, form, setForm, saving, showClave, setShowClave,
    saveEmpresa, deleting, setDeleting, confirmDelete, messageTarget, setMessageTarget,
    messageText, setMessageText, sending, sendNow, copyMessage, copied,
    whatsappListo, messageWaLink, markSent,
  } = controller;

  return (
    <>
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
                  onClick={() => setShowClave(!showClave)}
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
    </>
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
