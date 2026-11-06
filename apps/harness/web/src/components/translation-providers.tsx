"use client";

import { useEffect, useRef, useState } from "react";
import { call } from "@/lib/api";
import type { AgentConnection } from "./agent-providers";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogBody, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { HostyLoader } from "../../../../../shared/web/hosty-states";

type Kind = "codex" | "claude";
type Variant = { key: Kind; connectionId: string | null; model: string | null; suggestedModels: { id: string; label: string }[]; ready: boolean; reason?: string };
type Configuration = { variants: Variant[] };
type Directory = { connections: AgentConnection[] };

export function TranslationProviders() {
  const [data, setData] = useState<{ configuration: Configuration; connections: AgentConnection[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      call("/settings/translation", { signal: controller.signal }).then(response => response.json() as Promise<Configuration>),
      call("/connections", { signal: controller.signal }).then(response => response.json() as Promise<Directory>),
    ]).then(([configuration, directory]) => {
      if (!controller.signal.aborted) setData({ configuration, connections: directory.connections });
    }).catch(() => {
      if (!controller.signal.aborted) setError("Could not load translation settings. Reopen this tab to try again.");
    });
    return () => controller.abort();
  }, []);

  return <section className="flex max-w-3xl flex-col gap-4" aria-label="Translation providers">
    <p className="text-sm text-muted-foreground">
      Let authorized apps translate with Codex or Claude. Text is sent to the selected provider and uses the connected account’s allowance or API billing.
    </p>
    {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    {!data && !error && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><HostyLoader label={null} className="size-4 shrink-0" />Loading translation settings…</p>}
    {data && <div className="divide-y border-y">
      {data.configuration.variants.map(variant => <TranslationProviderRow key={variant.key} initial={variant}
        connections={data.connections.filter(connection => connection.kind === variant.key)} />)}
    </div>}
    {data && <p className="text-xs text-muted-foreground">
      Model and switch changes save automatically. Use a dedicated connection or close its chats before translating. Models apply only to translations.
    </p>}
  </section>;
}

function TranslationProviderRow({ initial, connections }: { initial: Variant; connections: AgentConnection[] }) {
  const modelTrigger = useRef<HTMLButtonElement>(null);
  const [variant, setVariant] = useState(initial);
  // Remember the selected account while toggling off, without enabling another account implicitly.
  const [connectionId, setConnectionId] = useState(initial.connectionId ?? (connections.length === 1 ? connections[0].id : ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [customModel, setCustomModel] = useState("");
  const label = variant.key === "codex" ? "Codex" : "Claude";
  const enabled = variant.connectionId !== null;
  const connection = connections.find(candidate => candidate.id === connectionId);
  const unavailable = enabled && !variant.ready;
  const customValid = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(customModel.trim());
  const customSelected = variant.model !== null && !variant.suggestedModels.some(model => model.id === variant.model);
  const reason = unavailable
    ? `${variant.reason ?? "The selected account is unavailable."} Turn translation off and on to reconnect.`
    : !connection?.available
      ? connections.length === 0 ? `Add a ${label} connection in Agent providers.`
        : !connectionId ? "Choose a connection to enable translation."
          : "Connection unavailable. Update it in Agent providers or choose another connection."
      : null;

  async function save(nextConnectionId: string | null, model: string | null) {
    setBusy(true); setError(null); setNotice(null);
    try {
      const configuration = await (await call(`/settings/translation/${variant.key}`, {
        method: "PUT", body: JSON.stringify({ connectionId: nextConnectionId, model }),
      })).json() as Configuration;
      const saved = configuration.variants.find(item => item.key === variant.key);
      if (!saved) throw new Error("Could not confirm translation settings. Reopen this tab to check them.");
      setVariant(saved);
      if (saved.connectionId !== null) setConnectionId(saved.connectionId);
      setNotice(`${label} translation settings saved.`);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save translation settings.");
      return false;
    } finally { setBusy(false); }
  }

  return <div role="group" aria-label={`${label} translation settings`} aria-busy={busy}
    className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-3 py-4 sm:grid-cols-[minmax(8rem,1fr)_minmax(0,18rem)_auto]">
    <div className="min-w-0">
      <label htmlFor={`translation-${variant.key}-enabled`} className="text-sm font-medium">{label}</label>
      {connections.length > 1 || (connectionId && !connection) ? <Select value={connectionId || undefined} disabled={busy}
        onValueChange={id => {
          if (enabled) void save(id, variant.model);
          else { setConnectionId(id); setError(null); setNotice(null); }
        }}>
        <SelectTrigger className="mt-1.5 w-full" aria-label={`${label} connection`}><SelectValue placeholder="Choose connection" /></SelectTrigger>
        <SelectContent><SelectGroup>
          {connectionId && !connection && <SelectItem value={connectionId} disabled>Unavailable connection</SelectItem>}
          {connections.map(candidate => <SelectItem key={candidate.id} value={candidate.id} disabled={!candidate.available}>
            {candidate.name}{candidate.available ? "" : " (unavailable)"}
          </SelectItem>)}
        </SelectGroup></SelectContent>
      </Select> : connection && connection.name !== label && <p className="truncate text-xs text-muted-foreground">{connection.name}</p>}
    </div>
    <div className="order-3 col-span-2 min-w-0 sm:order-2 sm:col-span-1">
      <Select value={variant.model ?? "__default__"} disabled={busy || unavailable} onValueChange={model => {
        if (model === "__custom__") { setCustomModel(variant.model ?? ""); setCustomOpen(true); }
        else void save(variant.connectionId, model === "__default__" ? null : model);
      }}>
        <SelectTrigger ref={modelTrigger} className="w-full" aria-label={`${label} model`}><SelectValue /></SelectTrigger>
        <SelectContent><SelectGroup>
          <SelectItem value="__default__">Agent default</SelectItem>
          {variant.suggestedModels.map(model => <SelectItem key={model.id} value={model.id}>{model.label}</SelectItem>)}
          {customSelected && <SelectItem value={variant.model!}>{variant.model}</SelectItem>}
          <SelectItem value="__custom__">Custom model ID…</SelectItem>
        </SelectGroup></SelectContent>
      </Select>
    </div>
    <Switch id={`translation-${variant.key}-enabled`} className="order-2 sm:order-3" aria-label={`Enable ${label} translation`}
      aria-describedby={reason ? `translation-${variant.key}-status` : undefined}
      checked={enabled} disabled={busy || (!enabled && !connection?.available)}
      onCheckedChange={checked => void save(checked ? connectionId : null, variant.model)} />
    {reason && <p id={`translation-${variant.key}-status`} className="order-4 col-span-full text-xs text-muted-foreground">{reason}</p>}
    {error && <Alert variant="destructive" className="order-4 col-span-full"><AlertDescription>{error}</AlertDescription></Alert>}
    <span role="status" className="sr-only">{busy ? `Saving ${label} translation settings…` : notice}</span>
    <Dialog open={customOpen} onOpenChange={open => { if (!busy) setCustomOpen(open); }}>
      <DialogContent onCloseAutoFocus={event => { event.preventDefault(); modelTrigger.current?.focus(); }}>
        <DialogHeader>
          <DialogTitle>{label} translation model</DialogTitle>
          <DialogDescription>Enter an exact model ID supported by your account and installed agent. This applies only to translations.</DialogDescription>
        </DialogHeader>
        <form className="flex min-h-0 flex-1 flex-col gap-4" onSubmit={event => {
          event.preventDefault();
          if (customValid && !busy) void save(variant.connectionId, customModel.trim()).then(saved => { if (saved) setCustomOpen(false); });
        }}>
          <DialogBody>
            <Field>
              <FieldLabel htmlFor={`translation-${variant.key}-custom-model`}>Model ID</FieldLabel>
              <Input id={`translation-${variant.key}-custom-model`} value={customModel} disabled={busy}
                maxLength={128} autoComplete="off" spellCheck={false} aria-describedby={`translation-${variant.key}-custom-help`}
                onChange={event => setCustomModel(event.target.value)} />
              <FieldDescription id={`translation-${variant.key}-custom-help`}>Start with a letter or number. Use up to 128 letters, numbers, dots, underscores or hyphens.</FieldDescription>
            </Field>
            {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setCustomOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={busy || !customValid}>Save model</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </div>;
}
