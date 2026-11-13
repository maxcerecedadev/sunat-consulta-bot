import { AlertTriangle, QrCode, Smartphone } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { WhatsAppStatus } from "./buzon-types";
import { stateLabel } from "./buzon-utils";

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

export { WhatsAppCard };
