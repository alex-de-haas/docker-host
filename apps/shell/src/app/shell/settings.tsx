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

export function SettingInput({ setting, value, disabled, onChange, onReveal }: { setting: CoreInstallSetting | CoreSetting; value: string; disabled?: boolean; onChange: (value: string) => void; onReveal?: () => Promise<string | null> }) {
  const controlId = `setting-${setting.key}`;
  const label = setting.label?.trim() || formatSettingLabel(setting.key);
  const description = setting.description?.trim();
  return (
    <div className="grid gap-2 sm:grid-cols-[1fr_2fr] sm:items-center sm:gap-4">
      <div className="flex min-w-0 items-center gap-2">
        <Label htmlFor={controlId} className="min-w-0 truncate" title={setting.key}>
          {label}
        </Label>
        {setting.required && <Badge variant="secondary">required</Badge>}
        {description && <SettingDescriptionHint description={description} />}
      </div>
      <div className="min-w-0">
        <SettingControl controlId={controlId} setting={setting} value={value} disabled={disabled} onChange={onChange} onReveal={onReveal} />
      </div>
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

// Values that read as "on" for a boolean setting. The switch writes the canonical "true"/"false", but a
// setting edited before typed controls existed (or by an app using looser parsing) may hold any of these,
// so we recognise the common truthy spellings when deciding the toggle's displayed state.
const truthyBooleanSettingValues = new Set(["true", "1", "yes", "on", "enabled"]);

function isBooleanSettingChecked(value: string) {
  return truthyBooleanSettingValues.has(value.trim().toLowerCase());
}

// Renders the editor matched to the setting's declared type: a toggle for booleans, a numeric field
// for numbers, an icon-prefixed URL field, a reveal-able password for secrets, and plain text otherwise.
function SettingControl({ controlId, setting, value, disabled, onChange, onReveal }: { controlId: string; setting: CoreInstallSetting | CoreSetting; value: string; disabled?: boolean; onChange: (value: string) => void; onReveal?: () => Promise<string | null> }) {
  const [revealed, setRevealed] = useState(false);
  // The stored value fetched on demand for a secret whose draft is untouched. Display-only: it never
  // enters the draft, so revealing cannot mark the form dirty or resave the value.
  const [stored, setStored] = useState<string | null>(null);
  const [revealError, setRevealError] = useState(false);
  // The value prop is typed string, but upstream setting values are nullable; coalesce so .trim()
  // never throws and the Input stays controlled even if a null slips through.
  const safeValue = value ?? "";

  if (setting.secret) {
    // Install-time settings never carry hasValue -- nothing is stored yet -- so they read "Not
    // set" until the operator types something. Platform rows never mark secret, so only app
    // summaries (which always carry the flag) can show "Unchanged".
    const hasStored = "hasValue" in setting && setting.hasValue === true;
    // A typed draft always wins; otherwise show the fetched stored value while revealed.
    const displayValue = safeValue.length > 0 ? safeValue : revealed && stored !== null ? stored : "";
    const toggleReveal = () => {
      setRevealError(false);
      if (revealed) {
        setRevealed(false);
        setStored(null);
        return;
      }
      setRevealed(true);
      // Fetch the stored value only when there is nothing typed to show and one exists to fetch.
      if (safeValue.length === 0 && hasStored && onReveal && stored === null) {
        onReveal().then(
          (fetched) => setStored(fetched ?? ""),
          () => {
            setRevealError(true);
            setRevealed(false);
          },
        );
      }
    };
    return (
      <div className="relative">
        <Input
          id={controlId}
          type={revealed ? "text" : "password"}
          className="pr-9"
          value={displayValue}
          placeholder={hasStored ? "Unchanged" : "Not set"}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          type="button"
          aria-label={revealed ? "Hide value" : "Show value"}
          aria-pressed={revealed}
          className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          disabled={disabled}
          onClick={toggleReveal}
        >
          {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
        {revealError && <p className="mt-1 text-xs text-destructive">Couldn&rsquo;t load the stored value.</p>}
      </div>
    );
  }

  if (setting.type === "boolean") {
    const checked = isBooleanSettingChecked(safeValue);
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

  if (setting.type === "select" && setting.options && setting.options.length > 0) {
    return (
      <select
        id={controlId}
        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        value={safeValue}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {setting.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
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
