"use client";

import { useEffect, useState } from "react";
import { call } from "@/lib/api";
import type { AgentConnection } from "./agent-providers";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";

type Kind = "codex" | "claude";
type Variant = { key: Kind; connectionId: string | null; model: string | null; suggestedModels: { id: string; label: string }[]; ready: boolean; reason?: string };
type Configuration = { variants: Variant[] };

export function TranslationProviders({ connections }: { connections: AgentConnection[] }) {
  const [configuration, setConfiguration] = useState<Configuration | null>(null);
  const [selection, setSelection] = useState<Partial<Record<Kind, string>>>({});
  const [models, setModels] = useState<Partial<Record<Kind, string>>>({});
  const [customModels, setCustomModels] = useState<Partial<Record<Kind, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void call("/settings/translation", { signal: controller.signal }).then(r => r.json()).then((value: Configuration) => {
      if (!controller.signal.aborted) {
        setError(null);
        setConfiguration(value);
        setSelection(Object.fromEntries(value.variants.map(v => [v.key, v.connectionId ?? "disabled"])));
        setModels(Object.fromEntries(value.variants.map(v => [v.key, !v.model ? "default" : v.suggestedModels.some(m => m.id === v.model) ? v.model : "custom"])));
        setCustomModels(Object.fromEntries(value.variants.map(v => [v.key, v.model ?? ""])));
      }
    }).catch(() => { if (!controller.signal.aborted) setError("Could not load translation settings."); });
    return () => controller.abort();
  }, [connections]);
  const save = async (key: Kind) => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const value = await (await call(`/settings/translation/${key}`, {
        method: "PUT", body: JSON.stringify({ connectionId: selection[key] === "disabled" ? null : selection[key],
          model: models[key] === "default" ? null : models[key] === "custom" ? customModels[key]?.trim() : models[key] }),
      })).json() as Configuration;
      setConfiguration(value);
      setNotice(`${key === "codex" ? "Codex" : "Claude"} translation settings saved.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save translation settings."); }
    finally { setBusy(false); }
  };
  return <section className="flex flex-col gap-4" aria-label="Translation providers">
    <div>
      <h3 className="text-sm font-medium">Translation providers</h3>
      <p className="text-sm text-muted-foreground">Allow authorized apps to translate text and Markdown plans using these accounts.
        Text is sent to the selected provider and uses that account&apos;s allowance or API billing.
        Choose a dedicated connection or stop its open chats before translating.</p>
    </div>
    {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    {!configuration && !error && <p className="text-sm text-muted-foreground">Loading translation settings…</p>}
    <FieldGroup>{configuration?.variants.map(variant => {
      const choices = connections.filter(c => c.kind === variant.key);
      const value = selection[variant.key] ?? "disabled";
      const label = variant.key === "codex" ? "Codex" : "Claude";
      const model = models[variant.key] ?? "default";
      const customValid = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(customModels[variant.key]?.trim() ?? "");
      return <div key={variant.key} role="group" aria-label={`${label} translation settings`} className="flex flex-col gap-4">
        <Field data-disabled={busy}>
          <FieldLabel htmlFor={`translation-${variant.key}`}>{label} translation</FieldLabel>
          <Select value={value} disabled={busy} onValueChange={id => setSelection(current => ({ ...current, [variant.key]: id }))}>
            <SelectTrigger id={`translation-${variant.key}`} aria-describedby={`translation-${variant.key}-status`}><SelectValue /></SelectTrigger>
            <SelectContent><SelectGroup>
              <SelectItem value="disabled">Disabled</SelectItem>
              {value !== "disabled" && !choices.some(c => c.id === value) && <SelectItem value={value}>Unavailable connection</SelectItem>}
              {choices.map(c => <SelectItem key={c.id} value={c.id}>{c.name}{c.available ? "" : " (unavailable)"}</SelectItem>)}
            </SelectGroup></SelectContent>
          </Select>
          <FieldDescription id={`translation-${variant.key}-status`}>{variant.ready ? "Configured. Requests use this account without chat history or host tools." : variant.reason}</FieldDescription>
        </Field>
        <Field data-disabled={busy}>
          <FieldLabel htmlFor={`translation-${variant.key}-model`}>{label} model</FieldLabel>
          <Select value={model} disabled={busy} onValueChange={id => setModels(current => ({ ...current, [variant.key]: id }))}>
            <SelectTrigger id={`translation-${variant.key}-model`} aria-describedby={`translation-${variant.key}-model-help`}><SelectValue /></SelectTrigger>
            <SelectContent><SelectGroup>
              <SelectItem value="default">Agent default</SelectItem>
              {variant.suggestedModels.map(m => <SelectItem key={m.id} value={m.id}>{m.label}</SelectItem>)}
              <SelectItem value="custom">Custom model ID</SelectItem>
            </SelectGroup></SelectContent>
          </Select>
          <FieldDescription id={`translation-${variant.key}-model-help`}>Applies only to translations. Availability depends on your account and installed agent.
            {variant.key === "claude" ? " Options marked as agent aliases follow the installed runtime; use an exact ID to pin a version." : " Luna is intended for simpler tasks; compare the results on your plans."}
            {" "}Agent default lets the agent choose. Requests use low reasoning effort.</FieldDescription>
        </Field>
        {model === "custom" && <Field data-disabled={busy}>
          <FieldLabel htmlFor={`translation-${variant.key}-custom-model`}>{label} custom model ID</FieldLabel>
          <Input id={`translation-${variant.key}-custom-model`} value={customModels[variant.key] ?? ""} disabled={busy}
            maxLength={128} autoComplete="off" spellCheck={false} aria-describedby={`translation-${variant.key}-custom-help`}
            onChange={event => setCustomModels(current => ({ ...current, [variant.key]: event.target.value }))} />
          <FieldDescription id={`translation-${variant.key}-custom-help`}>Start with a letter or number. Use up to 128 letters, numbers, dots, underscores or hyphens.</FieldDescription>
        </Field>}
        <Button type="button" variant="outline" size="sm" disabled={busy || (model === "custom" && !customValid)} onClick={() => void save(variant.key)}>Save {label} translation</Button>
      </div>;
    })}</FieldGroup>
  </section>;
}
