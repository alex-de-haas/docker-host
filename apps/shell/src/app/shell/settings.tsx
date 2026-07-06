"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import { ChevronDown, ChevronRight, Eye, EyeOff, Globe, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
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
  const controlId = `setting-${setting.key}`;
  const label = setting.label?.trim() || formatSettingLabel(setting.key);
  const description = setting.description?.trim();
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Label htmlFor={controlId} className="min-w-0 truncate" title={setting.key}>
          {label}
        </Label>
        <Badge variant="outline">{setting.secret ? "secret" : setting.type}</Badge>
        {setting.required && <Badge variant="secondary">required</Badge>}
        {description && <SettingDescriptionHint description={description} />}
      </div>
      <SettingControl controlId={controlId} setting={setting} value={value} disabled={disabled} onChange={onChange} />
    </div>
  );
}

// Info affordance shown next to a setting's label when the manifest provides a description. The text
// lives in a hover/focus tooltip so the form stays compact regardless of how many settings declare one.
function SettingDescriptionHint({ description }: { description: string }) {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="Setting description"
            className="text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none"
          >
            <Info className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-pretty">{description}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// Renders the editor matched to the setting's declared type: a toggle for booleans, a numeric field
// for numbers, an icon-prefixed URL field, a reveal-able password for secrets, and plain text otherwise.
function SettingControl({ controlId, setting, value, disabled, onChange }: { controlId: string; setting: CoreInstallSetting | CoreSetting; value: string; disabled?: boolean; onChange: (value: string) => void }) {
  const [revealed, setRevealed] = useState(false);
  // The value prop is typed string, but upstream setting values are nullable; coalesce so .trim()
  // never throws and the Input stays controlled even if a null slips through.
  const safeValue = value ?? "";

  if (setting.secret) {
    return (
      <div className="relative">
        <Input
          id={controlId}
          type={revealed ? "text" : "password"}
          className="pr-9"
          value={safeValue}
          placeholder="Unchanged"
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          type="button"
          aria-label={revealed ? "Hide value" : "Show value"}
          className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          disabled={disabled}
          onClick={() => setRevealed((current) => !current)}
        >
          {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
    );
  }

  if (setting.type === "boolean") {
    const checked = safeValue.trim().toLowerCase() === "true";
    return (
      <div className="flex items-center gap-2">
        <Switch id={controlId} checked={checked} disabled={disabled} onCheckedChange={(next) => onChange(next ? "true" : "false")} />
        <span className="text-sm text-muted-foreground">{checked ? "Enabled" : "Disabled"}</span>
      </div>
    );
  }

  if (setting.type === "number") {
    return (
      <Input
        id={controlId}
        type="number"
        inputMode="decimal"
        value={safeValue}
        placeholder="0"
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }

  if (setting.type === "url") {
    return (
      <div className="relative">
        <Globe className="pointer-events-none absolute inset-y-0 left-3 my-auto h-4 w-4 text-muted-foreground" />
        <Input
          id={controlId}
          type="url"
          className="pl-9"
          value={safeValue}
          placeholder="https://app.example.com"
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
    );
  }

  return (
    <Input
      id={controlId}
      type="text"
      value={safeValue}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    />
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
