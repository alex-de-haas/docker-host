import * as React from "react";
import { cn } from "@/lib/utils";

// The small label used by transcript cards. Kept minimal on purpose: this workspace pulls in the
// pieces its pages actually use rather than a whole component library.
export function Badge({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"span"> & { variant?: "default" | "secondary" | "outline" }) {
  return (
    <span
      data-slot="badge"
      className={cn(
        "inline-flex w-fit shrink-0 items-center justify-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        variant === "default" && "border-transparent bg-primary text-primary-foreground",
        variant === "secondary" && "border-transparent bg-secondary text-secondary-foreground",
        variant === "outline" && "text-foreground",
        className,
      )}
      {...props}
    />
  );
}
