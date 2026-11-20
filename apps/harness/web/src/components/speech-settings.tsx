"use client";
import { useEffect, useRef, useState } from "react";
import { call } from "@/lib/api";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { sameSpeechChoice, speechKinds, type SpeechChoice, type SpeechKind, type SpeechSettings } from "../../../shared/speech-selection";

const identity = (p: SpeechChoice) => JSON.stringify([p.appId, p.installationId, p.key, p.implementationId ?? null]);
const labels = { "speech-to-text": "Dictation", "text-to-speech": "Read aloud" };

export function SpeechSettingsPanel() {
  const [settings, setSettings] = useState<SpeechSettings | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const op = new AbortController(); lifetime.current = op;
    void call("/speech/settings", { signal: op.signal }).then(r => r.json()).then(value => {
      if (!op.signal.aborted) setSettings(value);
    }).catch(error => { if (!op.signal.aborted) setMessage(error.message); });
    return () => op.abort();
  }, []);
  async function save(kind: SpeechKind, value: string) {
    const signal = lifetime.current?.signal;
    if (!settings || busy || !signal || signal.aborted) return;
    const choice = settings.roles[kind].providers.find(p => identity(p) === value) ?? null;
    setBusy(true); setMessage("");
    try {
      await call("/speech/settings", { method: "PUT", signal, body: JSON.stringify({ account: settings.account, revision: settings.revision, kind, choice }) });
      if (!signal.aborted) setMessage(labels[kind] + " saved.");
    } catch (error) { if (!signal.aborted) setMessage(error instanceof Error ? error.message : "Could not save speech settings."); }
    finally {
      try {
        const response = await call("/speech/settings", { signal });
        const updated = await response.json() as SpeechSettings;
        if (!signal.aborted) setSettings(updated);
      } catch (e) { if (!signal.aborted) { setSettings(null); setMessage(e instanceof Error ? e.message : "Could not load speech settings."); } }
      if (!signal.aborted) setBusy(false);
    }
  }
  return <section aria-label="Speech" className="max-w-xl space-y-4">
    <h2 className="text-lg font-semibold">Speech</h2>
    {speechKinds.map(kind => {
      const role = settings?.roles[kind];
      if (!role) return null;
      const missing = role.selected && !role.providers.some(p => sameSpeechChoice(p, role.selected!));
      return <div key={kind} className="space-y-1"><label id={kind} className="text-sm font-medium">{labels[kind]}</label>
        <Select value={role.selected ? identity(role.selected) : "none"} onValueChange={v => void save(kind, v)} disabled={busy || !role.granted}>
          <SelectTrigger aria-labelledby={kind}><SelectValue /></SelectTrigger><SelectContent>
            <SelectItem value="none">Off</SelectItem>
            {missing && role.selected && <SelectItem value={identity(role.selected)} disabled>{role.selected.displayName} (unavailable)</SelectItem>}
            {role.providers.map(p => <SelectItem key={identity(p)} value={identity(p)} disabled={!p.available}>{p.displayName}{p.available ? "" : " (unavailable)"}</SelectItem>)}
          </SelectContent></Select>
        {!role.granted && <p className="text-sm text-muted-foreground">Enable the {kind} permission for Harness in Hosty.</p>}
        {role.granted && !role.providers.length && <p className="text-sm text-muted-foreground">No providers are available.</p>}
      </div>;
    })}
    {!settings && !message && <p role="status">Loading speech settings…</p>}
    {message && <p role="status">{message}</p>}
  </section>;
}
