"use client";

import { useState } from "react";
import { LayoutGrid } from "lucide-react";
import { DynamicIcon, iconNames } from "lucide-react/dynamic";
import type { ContextApp } from "@/lib/assistant-api";
import { cn } from "@/lib/utils";

// Match Shell's named-icon normalization, including PascalCase manifest names.
const normalize = (value: string) => value.replace(/[-_\s]/g, "").toLowerCase();
const names = new Map(iconNames.map(name => [normalize(name), name]));

export function ContextAppIcon({ app, className }: { app?: ContextApp; className?: string }) {
  return <IconImage key={`${app?.iconUrl ?? ""}:${app?.icon ?? ""}`} app={app} className={className} />;
}

function IconImage({ app, className }: { app?: ContextApp; className?: string }) {
  const [failed, setFailed] = useState(false);
  const name = names.get(normalize(app?.icon?.trim() ?? ""));
  return <span aria-hidden="true" className={cn("inline-flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-sm [&>svg]:size-full", className)}>
    {app?.iconUrl && !failed ? (
      // The URL is resolved and validated by the gateway; Core assets keep their existing session gate.
      // eslint-disable-next-line @next/next/no-img-element
      <img src={app.iconUrl} alt="" className="size-full object-contain" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
    ) : name ? <DynamicIcon name={name} fallback={() => <LayoutGrid />} /> : <LayoutGrid />}
  </span>;
}
