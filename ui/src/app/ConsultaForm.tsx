import { AlertCircle, Eye, EyeOff, Loader2, RefreshCcw, Search } from "lucide-react";

import { DateRangePicker, type DateRange } from "@/components/date-range-picker";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox, Field } from "./consulta-widgets";

export interface ConsultaFormProps {
  ruc: string;
  setRuc: (value: string) => void;
  user: string;
  setUser: (value: string) => void;
  password: string;
  setPassword: (value: string) => void;
  showPassword: boolean;
  setShowPassword: (value: boolean) => void;
  documento: string;
  setDocumento: (value: string) => void;
  documentos: Record<string, string>;
  tipo: string;
  setTipo: (value: string) => void;
  tipoOptions: { value: string; label: string }[];
  range: DateRange;
  setRange: (value: DateRange) => void;
  downloadPdf: boolean;
  setDownloadPdf: (value: boolean) => void;
  soloListar: boolean;
  setSoloListar: (value: boolean) => void;
  visible: boolean;
  setVisible: (value: boolean) => void;
  max: string;
  setMax: (value: string) => void;
  running: boolean;
  cancelling: boolean;
  onSubmit: (event: React.FormEvent) => void;
  onCancel: () => void;
}

export function ConsultaForm(props: ConsultaFormProps) {
  const {
    ruc, setRuc, user, setUser, password, setPassword, showPassword, setShowPassword,
    documento, setDocumento, documentos, tipo, setTipo, tipoOptions, range, setRange,
    downloadPdf, setDownloadPdf, soloListar, setSoloListar, visible, setVisible,
    max, setMax, running, cancelling, onSubmit, onCancel,
  } = props;

  return (
        <Card>
          <CardHeader>
            <CardTitle>Nueva consulta</CardTitle>
            <CardDescription>
              Se conecta al portal de SUNAT con tu Clave SOL. La clave no se guarda.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit} className="grid gap-5">
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
                      onClick={() => setShowPassword(!showPassword)}
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
                    onClick={onCancel}
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
  );
}
