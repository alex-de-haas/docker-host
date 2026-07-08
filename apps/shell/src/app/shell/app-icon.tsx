"use client";

import { useState } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

// Renders an app's manifest-declared display icon (manifest-level app assets) as an <img>, falling
// back to a Lucide icon when there is no icon URL or the image fails to load (e.g. the asset was never
// vendored, so the Core asset endpoint 404s). Keeping the fallback here means every icon site — sidebar
// app rows, sidebar page links, Installed Apps — degrades identically without repeating the logic.
export function AppIcon({
  src,
  fallback: Fallback,
  className,
  alt = "",
}: {
  src: string | null;
  fallback: LucideIcon;
  className?: string;
  alt?: string;
}) {
  const [failed, setFailed] = useState(false);

  if (src && !failed) {
    return (
      <img
        src={src}
        alt={alt}
        className={cn("shrink-0 object-contain", className)}
        loading="lazy"
        onError={() => setFailed(true)}
      />
    );
  }

  return <Fallback className={cn("shrink-0", className)} />;
}
