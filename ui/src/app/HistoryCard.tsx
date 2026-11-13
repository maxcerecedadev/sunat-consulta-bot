import { Eye, FolderOpen, Trash2 } from "lucide-react";

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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { HistoryItem } from "./consulta-types";
import { historyStatus } from "./consulta-utils";

export interface HistoryCardProps {
  history: HistoryItem[];
  page: number;
  total: number;
  totalPages: number;
  tipos: Record<string, string>;
  onLoadHistory: (page: number) => void;
  onOpen: (id: string) => void;
  onOpenFolder: (id: string) => void;
  onCancel: (id: string) => void;
  onDelete: (item: HistoryItem) => void;
}

export function HistoryCard({
  history,
  page,
  total,
  totalPages,
  tipos,
  onLoadHistory,
  onOpen,
  onOpenFolder,
  onCancel,
  onDelete,
}: HistoryCardProps) {
  const historyTypeLabel = (item: HistoryItem) => {
    const code = item.options?.tipo || "10";
    const label = tipos[code] || code;
    return item.options?.documento === "boleta"
      ? label.replace(/^Facturas/, "Boletas")
      : label;
  };

  if (history.length === 0) return null;

  return (
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
                  {history.map((item) => {
                    const status = historyStatus(item);
                    const stats = item.stats;
                    const filesSummary = stats
                      ? stats.total === 0
                        ? "Sin comprobantes"
                        : stats.soloListar
                          ? "Solo listado"
                          : [
                              `${stats.files} archivo(s)`,
                              stats.errors > 0 ? `${stats.errors} error(es)` : "",
                              stats.cdrFaltantes > 0
                                ? `${stats.cdrFaltantes} sin CDR`
                                : "",
                            ]
                              .filter(Boolean)
                              .join(" · ")
                      : "";

                    return (
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
                        <div>
                          {item.processed}/{item.total}
                        </div>
                        {filesSummary && (
                          <div className="text-[11.5px] text-muted-foreground">
                            {filesSummary}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={status.className}
                          title={item.message}
                        >
                          {status.label}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap justify-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            title="Abrir consulta"
                            onClick={() => {
                                                            onOpen(item.id);
                                                          }}
                          >
                            <Eye className="size-4" />
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            title="Abrir carpeta de la consulta"
                            onClick={() => void onOpenFolder(item.id)}
                          >
                            <FolderOpen className="size-4" />
                          </Button>
                          {["queued", "login", "listing", "processing"].includes(
                            item.status,
                          ) && (
                            <Button
                              variant="outline"
                              size="sm"
                              title="Cancelar consulta"
                              className="text-destructive hover:text-destructive"
                              onClick={() => void onCancel(item.id)}
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
                            onClick={() => onDelete(item)}
                            aria-label="Eliminar consulta"
                            className="text-destructive hover:text-destructive"
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-sm">
                <span className="text-muted-foreground">
                  {total} consulta(s)
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page <= 1}
                    onClick={() => void onLoadHistory(page - 1)}
                  >
                    Anterior
                  </Button>
                  <span className="text-muted-foreground">
                    Página {page} de {totalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page >= totalPages}
                    onClick={() => void onLoadHistory(page + 1)}
                  >
                    Siguiente
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
  );
}
