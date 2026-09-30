"use client";

import { useState } from "react";
import { LayoutGrid } from "lucide-react";
import { DynamicIcon, iconNames } from "lucide-react/dynamic";
import type { ContextApp } from "@/lib/assistant-api";
import { contextIconUrl } from "@/lib/context-icon-url";
import { cn } from "@/lib/utils";

// Match Shell's named-icon normalization, including PascalCase manifest names.
const normalize = (value: string) => value.replace(/[-_\s]/g, "").toLowerCase();
const names = new Map(iconNames.map(name => [normalize(name), name]));

export function ContextAppIcon({ app, className }: { app?: ContextApp; className?: string }) {
  const src = contextIconUrl(app?.iconUrl, app?.id ?? "", typeof window === "undefined" ? undefined : window.location.hostname);
  return <IconImage key={`${src ?? ""}:${app?.icon ?? ""}`} app={app} src={src} className={className} />;
}

function IconImage({ app, src, className }: { app?: ContextApp; src?: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  const name = names.get(normalize(app?.icon?.trim() ?? ""));
  return <span aria-hidden="true" className={cn("inline-flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-sm [&>svg]:size-full", className)}>
    {src && !failed ? (
      // Core assets keep their existing browser-session gate; local aliases match the current page.
      // eslint-disable-next-line @next/next/no-img-element
      <img src={src} alt="" className="size-full object-contain" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
    ) : name ? <DynamicIcon name={name} fallback={() => <LayoutGrid />} /> : <LayoutGrid />}
  </span>;
}
