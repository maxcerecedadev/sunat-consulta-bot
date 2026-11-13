import {
  Bell,
  Check,
  Copy,
  Inbox,
  Loader2,
  MessageCircle,
  Paperclip,
  Pencil,
  Plus,
  RefreshCcw,
  Send,
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
import { DateRangePicker } from "@/components/date-range-picker";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { BuzonController } from "./buzon-types";
import { formatDate } from "./buzon-utils";

export function BuzonControlCard(controller: BuzonController) {
  const {
    visible, setVisible, checking, openCreate, startCheck, empresas,
    pendientes, nuevos, basePendientes, job, copiedLog, copyJobLog, error, notice,
  } = controller;

  return (
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
                      {copiedLog ? "Copiado" : job.status === "error" ? "Copiar error" : "Copiar registro"}
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
  );
}

export function EmpresasCard(controller: BuzonController) {
  const { empresas, checking, startCheck, openEdit, setDeleting } = controller;

  return (
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
  );
}

export function NotificacionesCard(controller: BuzonController) {
  const {
    items, empresas, rangoFechas, setRangoFechas, empresaFiltro,
    setEmpresaFiltro, filtro, setFiltro, whatsappListo, sendingItem,
    openMessage, sendItemNow,
  } = controller;

  return (
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
  );
}
