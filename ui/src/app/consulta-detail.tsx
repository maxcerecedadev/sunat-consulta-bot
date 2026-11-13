import {
  Download,
  ExternalLink,
  FileCode2,
  FileText,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Invoice } from "./consulta-types";
import { exportUrl, fileUrl, money } from "./consulta-utils";

export function DetailBody({ record, jobId }: { record: Invoice; jobId: string }) {
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
