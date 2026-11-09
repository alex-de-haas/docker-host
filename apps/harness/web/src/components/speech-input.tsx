"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Mic, Square, X } from "lucide-react";
import { Tooltip } from "radix-ui";
import type { ProviderDescriptor, SpeechResult } from "@hosty-sdk/app/providers";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { call } from "@/lib/api";
import { recordingWave } from "@/lib/speech-audio";
import { startSpeechActivity, type SpeechActivityFrame } from "@/lib/speech-activity";
import { chatSpeechLimits, speechDuration, type SpeechLimits } from "../../../shared/speech";

type Roster = { granted: boolean; requestable?: boolean; reviewAvailable?: boolean; providers: ProviderDescriptor[] };
type Recording = { controller: AbortController; stream?: MediaStream; recorder?: MediaRecorder; timer?: ReturnType<typeof setTimeout>; clock?: ReturnType<typeof setInterval> };

/** Remount per conversation; cleanup invalidates every pending microphone/recognition operation. */
export function SpeechInput({ disabled, onText, onStart }: { disabled: boolean; onText: (text: string) => void; onStart?: () => void }) {
  const [roster, setRoster] = useState<Roster | null>(null);
  const [selected, setSelected] = useState("");
  const [phase, setPhase] = useState<"idle" | "starting" | "recording" | "transcribing">("idle");
  const [error, setError] = useState("");
  const [meterStream, setMeterStream] = useState<MediaStream>();
  const [rosterError, setRosterError] = useState("");
  const [capabilities, setCapabilities] = useState<{ provider: ProviderDescriptor; limits?: SpeechLimits; error?: string }>();
  const [elapsed, setElapsed] = useState(0);
  const active = useRef<Recording | null>(null);
  const onResult = useRef(onText);
  const blocked = useRef(disabled);
  useEffect(() => { onResult.current = onText; blocked.current = disabled; }, [onText, disabled]);
  // Disabling disposes the live recording (effect below); the phase follows in the same render.
  const [wasDisabled, setWasDisabled] = useState(disabled);
  if (disabled !== wasDisabled) {
    setWasDisabled(disabled);
    if (disabled) { setPhase("idle"); setMeterStream(undefined); }
  }
  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => { void call("/speech/providers", { signal: controller.signal }).then(r => r.json() as Promise<Roster>).then(value => { if (!controller.signal.aborted) { setRoster(value); setRosterError(""); } }).catch(cause => { if (!controller.signal.aborted) setRosterError(cause instanceof Error ? cause.message : "Speech providers are unavailable."); }); };
    refresh(); window.addEventListener("focus", refresh);
    return () => { controller.abort(); window.removeEventListener("focus", refresh); };
  }, []);
  useEffect(() => () => { dispose(active.current); active.current = null; }, []);
  useEffect(() => { if (disabled) { dispose(active.current); active.current = null; } }, [disabled]);
  const choice = selected || (roster?.providers.length === 1 ? identity(roster.providers[0]!) : "");
  const provider = roster?.providers.find(p => identity(p) === choice);
  const currentCapabilities = capabilities?.provider === provider ? capabilities : undefined;
  const limits = currentCapabilities?.limits;
  useEffect(() => {
    if (!provider?.available || !roster?.granted) return;
    const controller = new AbortController();
    void call(`/speech/capabilities?appId=${encodeURIComponent(provider.appId)}&key=${encodeURIComponent(provider.key)}`, { signal: controller.signal })
      .then(response => response.json()).then(value => {
        const limits = chatSpeechLimits(value);
        if (!controller.signal.aborted) setCapabilities({ provider, limits });
      }).catch(cause => {
        if (!controller.signal.aborted) setCapabilities({ provider, error: cause instanceof Error ? cause.message : "Recording limits are unavailable." });
      });
    return () => controller.abort();
  }, [provider, roster?.granted]);
  // Every path that ends an operation (finish, cancel, disable) also returns the phase to idle.
  const busy = phase !== "idle";
  function cancel() { dispose(active.current); active.current = null; setMeterStream(undefined); setPhase("idle"); }
  async function start() {
    if (!provider || !provider.available || !limits || blocked.current || active.current) return;
    onStart?.();
    const operation: Recording = { controller: new AbortController() }; active.current = operation;
    const valid = () => active.current === operation && !operation.controller.signal.aborted && !blocked.current;
    setPhase("starting"); setError("");
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") throw new Error("Microphone recording requires HTTPS (or localhost) and a supported browser.");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
      operation.stream = stream;
      if (!valid()) { dispose(operation); return; }
      const recorder = new MediaRecorder(stream); operation.recorder = recorder;
      const chunks: Blob[] = []; let size = 0;
      recorder.ondataavailable = event => { if (valid() && event.data.size) { size += event.data.size; if (size > 32 * 1024 * 1024) { cancel(); setError("Recording is too large. Try a shorter recording."); } else chunks.push(event.data); } };
      recorder.onerror = () => { if (valid()) { cancel(); setError("Microphone recording failed."); } };
      recorder.onstop = () => {
        clearTimeout(operation.timer); clearInterval(operation.clock); stream.getTracks().forEach(track => track.stop());
        if (!valid()) return;
        setMeterStream(undefined); setPhase("transcribing");
        void (async () => {
          try {
            const wave = await recordingWave(new Blob(chunks, { type: recorder.mimeType }), limits);
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
      recorder.start(1000); setMeterStream(stream); setPhase("recording");
      const startedAt = Date.now(); setElapsed(0);
      operation.clock = setInterval(() => { if (valid()) setElapsed((Date.now() - startedAt) / 1000); }, 1000);
      operation.timer = setTimeout(() => { if (recorder.state === "recording") recorder.stop(); }, Math.max(1, limits.maxDurationSeconds * 1000 - Math.min(1000, limits.maxDurationSeconds * 100)));
    } catch (cause) {
      if (valid()) { setError(cause instanceof Error ? cause.message : "Microphone access failed."); cancel(); }
    }
  }
  const unavailable = disabled || !roster?.granted || !provider?.available || !limits;
  const hint = disabled ? "Dictation is unavailable while a message is being sent."
    : rosterError ? `Could not check speech providers: ${rosterError}`
    : !roster ? "Checking speech-to-text availability…"
    : !roster.granted ? roster.reviewAvailable === true
      ? "In Hosty Dashboard, open Harness → Settings → Permissions, enable speech-to-text, then Review changes and confirm in Core."
      : roster.requestable === true
      ? "In Hosty Dashboard, open Harness → Settings → Permissions → Review optional permissions, then approve speech-to-text in Core."
      : roster.requestable === false
        ? "This Harness installation has no optional speech-to-text permission. Review an updated Harness manifest in Core before enabling dictation."
        : "Harness has no speech-to-text permission. Ask a host administrator to review its installation permissions."
    : roster.providers.length === 0 ? "No speech providers were found. Check your speech-to-text apps in Dashboard."
    : !provider ? "Choose a speech provider to enable dictation."
    : !provider.available ? `${provider.displayName} is unavailable. Check the app's status in Dashboard.`
    : currentCapabilities?.error ? `Could not check recording limits: ${currentCapabilities.error}`
    : !limits ? "Checking recording limits…"
    : `Dictate into your draft, up to ${speechDuration(limits.maxDurationSeconds)}`;
  return <div data-slot="speech-input" role="group" aria-label="Dictation" className="inline-flex max-w-64 shrink-0 flex-wrap items-center gap-1">
    {!busy && roster?.granted && roster.providers.length > 1 && <Select value={JSON.stringify(choice)} disabled={busy || disabled} onValueChange={value => setSelected(JSON.parse(value) as string)}>
      <SelectTrigger data-speech-provider size="sm" aria-label="Speech provider" title={provider?.displayName ?? "Choose a speech provider"} className="max-w-40"><SelectValue /></SelectTrigger>
      <SelectContent><SelectGroup>
        <SelectItem value={JSON.stringify("")}>Speech provider…</SelectItem>
        {roster.providers.map(p => <SelectItem key={identity(p)} value={JSON.stringify(identity(p))}>{p.displayName}{p.available ? "" : " (unavailable)"}</SelectItem>)}
      </SelectGroup></SelectContent>
    </Select>}
    {busy ? <>
      <span data-slot="speech-status" role="status" className="inline-flex size-8 items-center justify-center" title={phase === "recording" ? "Recording dictation" : phase === "starting" ? "Opening microphone…" : "Transcribing…"}>
        {phase === "recording" ? <SpeechActivityMeter stream={meterStream} /> : <Loader2 aria-hidden className="size-4 motion-safe:animate-spin" />}
        <span className="sr-only">{phase === "recording" ? "Recording dictation" : phase === "starting" ? "Opening microphone…" : "Transcribing…"}</span>
      </span>
      {phase === "recording" && limits && <span role="timer" aria-live="off" aria-label={`Recording duration, limit ${speechDuration(limits.maxDurationSeconds)}`} className="text-xs tabular-nums text-muted-foreground">{speechDuration(elapsed)} / {speechDuration(limits.maxDurationSeconds)}</span>}
      {phase === "recording" && <Button data-speech-control type="button" size="icon-sm" variant="ghost" aria-label="Stop recording" title="Stop and transcribe" onClick={() => { const recorder = active.current?.recorder; if (recorder?.state === "recording") recorder.stop(); }}><Square /></Button>}
      <Button data-speech-control type="button" size="icon-sm" variant="ghost" aria-label="Cancel dictation" title="Discard dictation" onClick={cancel}><X /></Button>
    </> : <Tooltip.Provider delayDuration={150}><Tooltip.Root>
      <Tooltip.Trigger asChild>
        <span className="inline-flex rounded-md outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-brand focus-visible:ring-0" tabIndex={unavailable ? 0 : undefined} aria-label={unavailable ? `Dictation unavailable. ${hint}` : undefined}>
          <Button data-speech-control type="button" size="icon-sm" variant="ghost" aria-label="Dictate" disabled={unavailable} onClick={() => void start()}><Mic /></Button>
        </span>
      </Tooltip.Trigger>
      <Tooltip.Portal><Tooltip.Content side="top" sideOffset={6} className="z-50 max-w-64 rounded-md bg-foreground px-3 py-2 text-xs text-background shadow-md">
        {hint}<Tooltip.Arrow className="fill-foreground" />
      </Tooltip.Content></Tooltip.Portal>
    </Tooltip.Root></Tooltip.Provider>}
    {rosterError && <p role="alert" className="w-full text-xs text-destructive-foreground">Could not check speech providers: {rosterError}</p>}
    {error && <p role="alert" className="w-full text-xs text-destructive-foreground">{error}</p>}
  </div>;
}
function SpeechActivityMeter({ stream }: { stream: MediaStream | undefined }) {
  const [activity, setActivity] = useState<SpeechActivityFrame>({ level: 0, speaking: false });
  useEffect(() => {
    if (!stream) return;
    let current = true;
    const stop = startSpeechActivity(stream, value => { if (current) setActivity(value); });
    return () => { current = false; stop(); };
  }, [stream]);
  if (activity.available === false) return <Mic aria-hidden data-speech-meter-unavailable className="size-4 text-muted-foreground" />;
  return <span data-speech-meter data-speaking={activity.speaking} aria-hidden className={`inline-flex h-6 items-center gap-[2px] ${activity.speaking ? "text-success-foreground" : "text-muted-foreground"}`}>
    {[0.45, 0.75, 1, 0.75, 0.45].map((weight, index) => <span key={index} data-speech-bar
      className="w-[3px] rounded-full bg-current motion-safe:transition-[height] motion-safe:duration-75"
      style={{ height: `${2 + Math.max(0, Math.min(1, activity.level)) * weight * 20}px` }} />)}
  </span>;
}
function identity(provider: ProviderDescriptor) { return JSON.stringify([provider.appId, provider.key]); }
function dispose(operation: Recording | null) {
  if (!operation) return;
  operation.controller.abort(); clearTimeout(operation.timer);
  clearInterval(operation.clock);
  if (operation.recorder?.state === "recording") operation.recorder.stop();
  operation.stream?.getTracks().forEach(track => track.stop());
}
