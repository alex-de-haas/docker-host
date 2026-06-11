"use client";

import type { ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { CoreApp, CoreEndpoint, CoreInstallSetting, CoreSetting } from "./types";

export function ConfigureSection({ title, testId, count, open, attention, onOpenChange, children }: { title: string; testId: string; count: number; open: boolean; attention?: boolean; onOpenChange: (open: boolean) => void; children: ReactNode }) {
  return (
    <section data-testid={testId} className="rounded-md border bg-background">
      <button
        type="button"
        className="flex min-h-12 w-full items-center justify-between gap-3 px-3 text-left"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      >
        <span className="flex min-w-0 items-center gap-2">
          {open ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
          <span className="truncate text-sm font-medium">{title}</span>
          <Badge variant={attention ? "default" : "outline"}>{count}</Badge>
        </span>
      </button>
      {open && <div className="border-t p-3">{children}</div>}
    </section>
  );
}

export function PublicOriginInput({ setting, endpoint, value, disabled, onChange }: { setting: CoreSetting; endpoint?: CoreEndpoint; value: string; disabled?: boolean; onChange: (value: string) => void }) {
  const currentUrl = endpoint?.url || "not assigned";
  const endpointKey = endpoint?.key || getPublicOriginEndpointLabel(setting.key);
  const inputLabel = `Public origin for ${endpoint?.service || "service"} ${endpointKey}`;

  return (
    <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(18rem,1fr)] md:items-center">
      <div className="min-w-0 rounded-md border bg-muted/30 px-3 py-2 text-xs">
        <div className={cn("truncate font-mono", endpoint?.url ? "text-foreground" : "text-muted-foreground")}>{currentUrl}</div>
      </div>
      <Input
        id={`setting-${setting.key}`}
        type="url"
        value={value}
        aria-label={inputLabel}
        placeholder={`https://${endpointKey || "app"}.example.com`}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

export function SettingInput({ setting, value, disabled, onChange }: { setting: CoreInstallSetting | CoreSetting; value: string; disabled?: boolean; onChange: (value: string) => void }) {
  const label = formatSettingLabel(setting.key);
  return (
    <div className="space-y-2">
      <Label htmlFor={`setting-${setting.key}`} className="flex items-center gap-2" title={setting.key}>
        {label}
        <Badge variant="outline">{setting.secret ? "secret" : setting.type}</Badge>
        {setting.required && <Badge variant="secondary">required</Badge>}
      </Label>
      <Input
        id={`setting-${setting.key}`}
        type={setting.secret ? "password" : setting.type === "url" ? "url" : "text"}
        value={value}
        placeholder={setting.secret ? "Unchanged" : setting.type === "url" ? "https://app.example.com" : undefined}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

const publicOriginSettingPrefix = "HOSTY_PUBLIC_ORIGIN_";

export function isPublicOriginSettingKey(key: string) {
  return key.startsWith(publicOriginSettingPrefix);
}

export function getPublicOriginEndpointLabel(key: string) {
  if (!isPublicOriginSettingKey(key)) {
    return "";
  }

  return key.slice(publicOriginSettingPrefix.length).toLowerCase().replaceAll("_", ".");
}

export function formatSettingLabel(key: string) {
  if (isPublicOriginSettingKey(key)) {
    const endpoint = getPublicOriginEndpointLabel(key);
    return endpoint.length > 0 ? `Public origin (${endpoint})` : "Public origin";
  }

  return key;
}

export function findPublicOriginEndpoint(app: CoreApp, settingKey: string) {
  return app.endpoints?.find((endpoint) => buildPublicOriginSettingKey(endpoint.key) === settingKey);
}

export function buildPublicOriginGroups(app: CoreApp, settings: CoreSetting[]) {
  const groups = new Map<string, { service: string; items: Array<{ setting: CoreSetting; endpoint?: CoreEndpoint }> }>();
  for (const setting of settings) {
    const endpoint = findPublicOriginEndpoint(app, setting.key);
    const service = endpoint?.service?.trim() || "service";
    const group = groups.get(service) ?? { service, items: [] };
    group.items.push({ setting, endpoint });
    groups.set(service, group);
  }

  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      items: group.items.sort((left, right) =>
        (left.endpoint?.key || left.setting.key).localeCompare(right.endpoint?.key || right.setting.key)),
    }))
    .sort((left, right) => left.service.localeCompare(right.service));
}

export function buildPublicOriginSettingKey(endpointKey: string) {
  return `${publicOriginSettingPrefix}${normalizePublicOriginEndpointKey(endpointKey)}`;
}

export function normalizePublicOriginEndpointKey(value: string) {
  const normalized = (value || "endpoint")
    .split("")
    .map((character) => /[a-zA-Z0-9]/.test(character) ? character.toUpperCase() : "_")
    .join("")
    .replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : "ENDPOINT";
}

export function hasMissingRequiredSettings(settings: CoreSetting[], draft: Record<string, string>) {
  return settings.some((setting) => setting.required && !setting.secret && (draft[setting.key] ?? "").trim().length === 0);
}
