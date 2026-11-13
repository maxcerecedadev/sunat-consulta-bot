import { useState } from "react";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  CloudDownload,
  Copy,
  Download,
  ExternalLink,
  Eye,
  FileCode2,
  FileText,
  FolderOpen,
  Info,
  Loader2,
  RefreshCcw,
  Search,
  Trash2,
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
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { cn } from "@/lib/utils";
import {
  type HistoryItem,
  type Invoice,
  type Job,
} from "./consulta-types";
import {
  exportUrl,
  fileUrl,
  invoiceTypeLabel,
  money,
  progressPercent,
  statusTitle,
  historyStatus,
} from "./consulta-utils";

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-2">
      <Label className="text-[10.5px] font-bold uppercase tracking-wider text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

export function Checkbox({
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

export function StatusCard({ job }: { job: Job }) {
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

export function ResultsCard({
  job,
  onDetail,
}: {
  job: Job;
  onDetail: (invoice: Invoice) => void;
}) {
  const isReceived = ["11", "14", "16"].includes(job.options.tipo);
  const stats = job.stats;
  const errorCount = stats?.errors ?? job.invoices.filter((invoice) => invoice.error).length;

  const warning = stats?.soloListar
    ? "Esta consulta se ejecutó en modo Solo listar: no se descargaron XML, PDF ni CDR."
    : stats && job.invoices.length > 0 && stats.withFiles === 0
      ? "No se descargó ningún archivo. Revisa los errores de cada comprobante o descarga errores.csv."
      : stats && errorCount > 0
        ? `${errorCount} comprobante(s) quedaron con error de descarga. Revisa el detalle o descarga errores.csv.`
        : stats && stats.cdrFaltantes > 0
          ? `SUNAT no devolvió el CDR de ${stats.cdrFaltantes} comprobante(s).`
          : "";

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
      {errorCount > 0 && (
        <a
          className="font-semibold text-destructive hover:underline"
          href={exportUrl(job.id, "errores.csv")}
          download
        >
          Descargar errores
        </a>
      )}
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
          <CardDescription>
            {job.invoices.length} comprobante(s) encontrado(s)
            {stats
              ? ` · XML ${stats.xml} · PDF ${stats.pdf} · CDR ${stats.cdr}`
              : ""}
          </CardDescription>
        </div>
        {exports}
      </CardHeader>
      <CardContent className="p-0">
        {warning && (
          <div className="flex items-start gap-3 border-b border-amber-500/25 bg-amber-500/5 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span className="min-w-0 flex-1 break-words">{warning}</span>
          </div>
        )}
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
                    {invoice.error && (
                      <span
                        className="block max-w-56 truncate text-[11.5px] text-destructive"
                        title={invoice.error}
                      >
                        Error: {invoice.error}
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
