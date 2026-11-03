"use client";
import { useEffect, useRef, useState } from "react";
import { appFetch } from "@hosty-sdk/app/browser-auth";
import { Loader2, Mic, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { recordingWave } from "./feedback-audio";
type Provider = { appId: string; key: string; displayName: string; available: boolean };
type Recording = { controller: AbortController; onText: (text: string) => void; stream?: MediaStream; recorder?: MediaRecorder; timer?: ReturnType<typeof setTimeout> };
const dispose = (op: Recording | null) => { if (!op) return; op.controller.abort(); clearTimeout(op.timer); if (op.recorder?.state === "recording") op.recorder.stop(); op.stream?.getTracks().forEach(t => t.stop()); };

/** One recorder and provider roster per draft; each operation owns its destination callback. */
export function useFeedbackSpeech(path: string, disabled: boolean) {
  const [providers, setProviders] = useState<Provider[]>([]), [choice, setChoice] = useState("");
  const [phase, setPhase] = useState<"idle" | "starting" | "recording" | "transcribing">("idle"), [error, setError] = useState("");
  const [target, setTarget] = useState<string | null>(null);
  const active = useRef<Recording | null>(null);
  const endpoint = path + "/speech";
  useEffect(() => {
    const abort = new AbortController();
    void appFetch(endpoint, { credentials: "include", signal: abort.signal }).then(async response => {
      const value = await response.json(); if (!response.ok) throw new Error(value.message ?? "Speech input is unavailable.");
      if (!abort.signal.aborted) { setProviders(value.granted ? value.providers ?? [] : []); if (!value.granted) setError("Speech input is not enabled for this application."); }
    }).catch(e => { if (!abort.signal.aborted) setError(e.message); });
    return () => { abort.abort(); dispose(active.current); active.current = null; };
  }, [endpoint]);
  // Recording cancellation synchronizes browser media resources with the disabled state.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (disabled) { dispose(active.current); active.current = null; setPhase("idle"); } }, [disabled]);
  const selected = providers.find(p => JSON.stringify([p.appId, p.key]) === choice) ?? (providers.length === 1 ? providers[0] : undefined);
  function cancel() { dispose(active.current); active.current = null; setPhase("idle"); }
  async function start(targetId: string, onText: (text: string) => void) {
    if (!selected?.available || disabled || active.current) return;
    const op: Recording = { controller: new AbortController(), onText }; active.current = op;
    const valid = () => active.current === op && !op.controller.signal.aborted;
    setTarget(targetId); setPhase("starting"); setError("");
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") throw new Error("This browser cannot record audio here. Type your comment instead.");
      op.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!valid()) { dispose(op); return; }
      const recorder = new MediaRecorder(op.stream); op.recorder = recorder; const chunks: Blob[] = []; let bytes = 0;
      recorder.ondataavailable = e => { if (!valid()) return; bytes += e.data.size; if (bytes > 16 * 1024 * 1024) { cancel(); setError("Recording is too large. Try a shorter comment."); } else if (e.data.size) chunks.push(e.data); };
      recorder.onerror = () => { if (valid()) { cancel(); setError("Recording failed. Type your comment or try again."); } };
      recorder.onstop = () => {
        clearTimeout(op.timer); op.stream?.getTracks().forEach(t => t.stop()); if (!valid()) return;
        setPhase("transcribing");
        void (async () => {
          try {
            const wave = await recordingWave(new Blob(chunks, { type: recorder.mimeType })); if (!valid()) return;
            const data = new Uint8Array(await wave.arrayBuffer()); let binary = "";
            for (let at = 0; at < data.length; at += 8192) binary += String.fromCharCode(...data.subarray(at, at + 8192));
            const response = await appFetch(endpoint, { method: "POST", credentials: "include", signal: op.controller.signal,
              headers: { "content-type": "application/json" }, body: JSON.stringify({ appId: selected.appId, key: selected.key, audio: btoa(binary) }) });
            const value = await response.json(); if (!response.ok) throw new Error(value.message ?? "Speech recognition failed.");
            if (valid()) { if (typeof value.text === "string" && value.text.trim()) op.onText(value.text.trim()); else setError("No speech detected."); }
          } catch (e) { if (valid()) setError(e instanceof Error ? e.message : "Speech recognition failed."); }
          finally { if (active.current === op) cancel(); }
        })();
      };
      recorder.start(1000); setPhase("recording"); op.timer = setTimeout(() => { if (recorder.state === "recording") recorder.stop(); }, 60_000);
    } catch (e) { if (valid()) { cancel(); setError(e instanceof Error ? e.message : "Microphone access failed."); } }
  }
  return { providers, choice, setChoice, phase, target, error, available: !!selected?.available, start, cancel,
    stop: () => { if (active.current?.recorder?.state === "recording") active.current.recorder.stop(); } };
}

export type FeedbackSpeechController = ReturnType<typeof useFeedbackSpeech>;

export function FeedbackSpeech({ speech, target, disabled, onText }: {
  speech: FeedbackSpeechController; target: string; disabled: boolean; onText: (text: string) => void;
}) {
  const active = speech.target === target && speech.phase !== "idle";
  const label = speech.phase === "recording" ? "Stop and transcribe" : speech.phase === "starting" ? "Opening microphone…" : "Transcribing…";
  return <div className="flex shrink-0 items-center gap-1">
    {active ? <>
      <Button type="button" variant="ghost" size="icon-sm" aria-label={label} title={label}
        disabled={speech.phase !== "recording"} onClick={speech.stop}>
        {speech.phase === "recording" ? <Square className="text-destructive" /> : <Loader2 className="motion-safe:animate-spin" />}
      </Button>
      <Button type="button" variant="ghost" size="icon-sm" aria-label="Cancel dictation" title="Cancel dictation" onClick={speech.cancel}><X /></Button>
      <span role="status" className="sr-only">{label}</span>
    </> : <Button type="button" variant="ghost" size="icon-sm" aria-label="Dictate"
      title={speech.error || (!speech.providers.length ? "No speech provider is available" : !speech.available ? "Choose an available speech provider" : "Dictate up to one minute")}
      disabled={disabled || !speech.available || speech.phase !== "idle"} onClick={() => void speech.start(target, onText)}><Mic /></Button>}
  </div>;
}
