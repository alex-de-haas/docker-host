"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Mic, Square, X } from "lucide-react";
import type { ProviderDescriptor, SpeechResult } from "@hosty-sdk/app/providers";
import { Button } from "@/components/ui/button";
import { call } from "@/lib/api";
import { recordingWave } from "@/lib/speech-audio";

type Roster = { granted: boolean; providers: ProviderDescriptor[] };
type Recording = { controller: AbortController; stream?: MediaStream; recorder?: MediaRecorder; timer?: ReturnType<typeof setTimeout> };

/** Remount per conversation; cleanup invalidates every pending microphone/recognition operation. */
export function SpeechInput({ disabled, onText }: { disabled: boolean; onText: (text: string) => void }) {
  const [roster, setRoster] = useState<Roster | null>(null);
  const [selected, setSelected] = useState("");
  const [phase, setPhase] = useState<"idle" | "starting" | "recording" | "transcribing">("idle");
  const [error, setError] = useState("");
  const active = useRef<Recording | null>(null);
  const onResult = useRef(onText); onResult.current = onText;
  const blocked = useRef(disabled); blocked.current = disabled;
  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => { void call("/speech/providers", { signal: controller.signal }).then(r => r.json() as Promise<Roster>).then(value => { if (!controller.signal.aborted) setRoster(value); }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Speech providers are unavailable."); }); };
    refresh(); window.addEventListener("focus", refresh);
    return () => { controller.abort(); window.removeEventListener("focus", refresh); };
  }, []);
  useEffect(() => () => { dispose(active.current); active.current = null; }, []);
  useEffect(() => { if (disabled) { dispose(active.current); active.current = null; } }, [disabled]);
  const choice = selected || (roster?.providers.length === 1 ? identity(roster.providers[0]!) : "");
  const provider = roster?.providers.find(p => identity(p) === choice);
  // A completed/cancelled operation has no live recording even if its last status was busy.
  const busy = phase !== "idle" && active.current !== null;
  function cancel() { dispose(active.current); active.current = null; setPhase("idle"); }
  async function start() {
    if (!provider || !provider.available || blocked.current || active.current) return;
    const operation: Recording = { controller: new AbortController() }; active.current = operation;
    const valid = () => active.current === operation && !operation.controller.signal.aborted && !blocked.current;
    setPhase("starting"); setError("");
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") throw new Error("Microphone recording requires HTTPS (or localhost) and a supported browser.");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      operation.stream = stream;
      if (!valid()) { dispose(operation); return; }
      const recorder = new MediaRecorder(stream); operation.recorder = recorder;
      const chunks: Blob[] = []; let size = 0;
      recorder.ondataavailable = event => { if (event.data.size) { size += event.data.size; if (size > 32 * 1024 * 1024) { cancel(); setError("Recording is too large. Try a shorter recording."); } else chunks.push(event.data); } };
      recorder.onerror = () => { if (valid()) { cancel(); setError("Microphone recording failed."); } };
      recorder.onstop = () => {
        clearTimeout(operation.timer); stream.getTracks().forEach(track => track.stop());
        if (!valid()) return;
        setPhase("transcribing");
        void (async () => {
          try {
            const wave = await recordingWave(new Blob(chunks, { type: recorder.mimeType }));
            if (!valid()) return;
            const response = await call(`/speech/transcriptions?appId=${encodeURIComponent(provider.appId)}&key=${encodeURIComponent(provider.key)}`, {
              method: "POST", body: wave, headers: { "content-type": "audio/wav" }, signal: operation.controller.signal,
            });
            const result = await response.json() as SpeechResult;
            if (valid()) { if (result.text.trim()) onResult.current(result.text.trim()); else setError("No speech detected. Try recording again."); }
          } catch (cause) { if (valid()) setError(cause instanceof Error ? cause.message : "Speech recognition failed."); }
          finally { if (active.current === operation) { dispose(operation); active.current = null; setPhase("idle"); } }
        })();
      };
      recorder.start(1000); setPhase("recording");
      operation.timer = setTimeout(() => { if (recorder.state === "recording") recorder.stop(); }, 119_000);
    } catch (cause) {
      if (valid()) { setError(cause instanceof Error ? cause.message : "Microphone access failed."); cancel(); }
    }
  }
  const hint = !roster?.granted ? "Allow speech-to-text in Harness app settings to enable dictation." : !provider ? "Choose a speech provider." : !provider.available ? "Selected speech provider is unavailable." : "Dictate into your draft";
  return <div className="flex flex-wrap items-center gap-1">
    {roster?.granted && roster.providers.length > 1 && <select aria-label="Speech provider" className="max-w-40 rounded border bg-background p-1 text-xs" value={choice} disabled={busy || disabled} onChange={e => setSelected(e.target.value)}>
      <option value="">Speech provider…</option>{roster.providers.map(p => <option key={identity(p)} value={identity(p)}>{p.displayName}{p.available ? "" : " (unavailable)"}</option>)}
    </select>}
    {busy ? <>
      <Button type="button" size="icon" variant="ghost" aria-label={phase === "recording" ? "Stop recording" : "Transcribing"} disabled={phase !== "recording"} onClick={() => active.current?.recorder?.stop()}>{phase === "recording" ? <Square /> : <Loader2 className="animate-spin" />}</Button>
      <Button type="button" size="icon" variant="ghost" aria-label="Cancel dictation" onClick={cancel}><X /></Button>
      <span role="status" className="text-xs">{phase === "recording" ? "Recording (up to 120 s)" : phase === "starting" ? "Opening microphone…" : "Transcribing…"}</span>
    </> : <Button type="button" size="icon" variant="ghost" aria-label="Dictate" title={hint} disabled={disabled || !roster?.granted || !provider?.available} onClick={() => void start()}><Mic /></Button>}
    {error && <p role="alert" className="w-full text-xs text-destructive">{error}</p>}
  </div>;
}
function identity(provider: ProviderDescriptor) { return JSON.stringify([provider.appId, provider.key]); }
function dispose(operation: Recording | null) {
  if (!operation) return;
  operation.controller.abort(); clearTimeout(operation.timer);
  if (operation.recorder?.state === "recording") operation.recorder.stop();
  operation.stream?.getTracks().forEach(track => track.stop());
}
