import { Bell, CloudDownload } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import packageInfo from "../../../package.json";

export type Vista = "comprobantes" | "buzon";

export function AppHeader({
  view,
  onChange,
}: {
  view: Vista;
  onChange: (view: Vista) => void;
}) {
  return (
    <header className="sticky top-0 z-20 border-b border-border/60 bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-xl bg-gradient-to-br from-primary to-secondary text-white shadow-lg shadow-primary/25">
            <CloudDownload className="size-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Consulta SUNAT</h1>
            <p className="text-xs text-muted-foreground">
              Comprobantes, Buzón SOL y WhatsApp
            </p>
          </div>
        </div>
        <nav className="flex items-center gap-1 rounded-xl border border-border/70 bg-muted/40 p-1">
          <Button
            variant={view === "comprobantes" ? "default" : "ghost"}
            size="sm"
            onClick={() => onChange("comprobantes")}
          >
            <CloudDownload className="size-4" />
            Comprobantes
          </Button>
          <Button
            variant={view === "buzon" ? "default" : "ghost"}
            size="sm"
            onClick={() => onChange("buzon")}
          >
            <Bell className="size-4" />
            Buzón SOL
          </Button>
        </nav>
        <Badge variant="outline" className="border-border/70 bg-muted/40 text-muted-foreground">
          v{packageInfo.version}
        </Badge>
      </div>
    </header>
  );
}
