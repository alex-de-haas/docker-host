// Adapted from the ReUI Radix Vega Alert. See ../reui/LICENSE.
import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const alertVariants = cva(
  "relative grid w-full min-w-0 grid-cols-[0_minmax(0,1fr)] items-start gap-y-0.5 rounded-lg border px-3 py-2.5 text-sm has-[>svg]:grid-cols-[calc(var(--spacing)*4)_minmax(0,1fr)] has-[>svg]:gap-x-2.5 [&>svg]:size-4 [&>svg]:translate-y-0.5",
  {
    variants: {
      variant: {
        default: "bg-card text-card-foreground",
        destructive: "border-destructive/30 bg-destructive-soft text-destructive-foreground *:data-[slot=alert-description]:text-destructive-foreground",
        info: "border-info/30 bg-info-soft [&>svg]:text-info-foreground",
        success: "border-success/30 bg-success-soft [&>svg]:text-success-foreground",
        warning: "border-warning/30 bg-warning-soft [&>svg]:text-warning-foreground",
        invert: "border-invert bg-invert text-invert-foreground *:data-[slot=alert-description]:text-invert-foreground/70",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Alert({ className, variant, ...props }: ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return <div data-slot="alert" role="alert" className={cn(alertVariants({ variant }), className)} {...props} />;
}

function AlertTitle({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="alert-title" className={cn("col-start-2 min-w-0 wrap-anywhere font-medium tracking-tight", className)} {...props} />;
}

function AlertDescription({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="alert-description" className={cn("col-start-2 grid min-w-0 justify-items-start gap-1 wrap-anywhere text-sm text-muted-foreground", className)} {...props} />;
}

function AlertAction({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="alert-action" className={cn("col-start-2 mt-1.5 flex min-w-0 flex-wrap items-center gap-2", className)} {...props} />;
}

export { Alert, AlertTitle, AlertDescription, AlertAction };
