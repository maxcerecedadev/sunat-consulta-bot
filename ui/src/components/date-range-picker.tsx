import { format } from "date-fns";
import { es } from "date-fns/locale";
import { CalendarIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface DateRange {
  from: Date | undefined;
  to?: Date | undefined;
}

interface DateRangePickerProps {
  value: DateRange;
  onChange: (range: DateRange) => void;
  className?: string;
}

export function DateRangePicker({ value, onChange, className }: DateRangePickerProps) {
  const label = value.from
    ? value.to
      ? `${format(value.from, "dd/MM/yyyy", { locale: es })} - ${format(value.to, "dd/MM/yyyy", {
          locale: es,
        })}`
      : format(value.from, "dd/MM/yyyy", { locale: es })
    : "Selecciona el periodo";

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className={cn(
            "h-10 w-full justify-start rounded-xl px-3 text-left text-sm font-normal",
            !value.from && "text-muted-foreground",
            className,
          )}
        >
          <CalendarIcon className="size-4 shrink-0" />
          <span className="truncate">{label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="range"
          selected={value}
          onSelect={(range) => onChange(range ?? { from: undefined })}
          numberOfMonths={1}
          locale={es}
          defaultMonth={value.from ?? new Date()}
        />
      </PopoverContent>
    </Popover>
  );
}
