import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-semibold normal-case transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:ring-4 focus-visible:ring-primary/10 hover:scale-[1.02] active:scale-[0.97]",
  {
    variants: {
      variant: {
        default: "bg-primary text-white shadow-xl shadow-primary/20 hover:bg-primary/90",
        destructive:
          "bg-destructive text-white hover:bg-destructive/90 shadow-lg shadow-destructive/10",
        outline: "border-2 border-border bg-background hover:bg-muted/50 hover:border-primary/30",
        secondary: "bg-secondary text-white hover:bg-secondary/90 shadow-md",
        ghost: "hover:bg-primary/5 hover:text-primary",
        link: "text-primary underline-offset-4 hover:underline lowercase first-letter:uppercase",
      },
      size: {
        default: "h-11 px-6 px-4 py-2 has-[>svg]:px-5",
        sm: "h-9 rounded-xl gap-1.5 px-4 has-[>svg]:px-3.5",
        lg: "h-14 rounded-xl px-8 has-[>svg]:px-6 text-sm",
        xl: "h-12 rounded-xl px-10 has-[>svg]:px-8 text-sm",
        icon: "size-11",
        "icon-sm": "size-9 rounded-xl",
        "icon-lg": "size-14 rounded-xl",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export { Button, buttonVariants };
