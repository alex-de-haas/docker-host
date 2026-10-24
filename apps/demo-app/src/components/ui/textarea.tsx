import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea data-slot="textarea" className={cn(
    "min-h-24 w-full min-w-0 rounded-lg border border-input bg-card px-3 py-2 text-sm placeholder:text-muted-foreground transition-colors disabled:cursor-not-allowed disabled:opacity-45 outline-none focus-visible:border-brand focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-brand focus-visible:ring-0 aria-invalid:border-destructive aria-invalid:focus-visible:outline-destructive",
    className,
  )} {...props} />;
}
