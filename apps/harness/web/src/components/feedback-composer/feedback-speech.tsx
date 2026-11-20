"use client";
import { useEffect, useRef, useState } from "react";
import { appFetch } from "@hosty-sdk/app/browser-auth";
import { Loader2, Mic, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { recordingWave } from "./feedback-audio";
import { useSpeechRoster } from "@/lib/use-speech-roster";
import { currentSpeechOption } from "../../../../shared/speech-selection";
type Recording = { binding: string; controller: AbortController; onText: (text: string) => void; stream?: MediaStream; recorder?: MediaRecorder; timer?: ReturnType<typeof setTimeout> };
const dispose = (op: Recording | null) => { if (!op) return; op.controller.abort(); clearTimeout(op.timer); if (op.recorder?.state === "recording") op.recorder.stop(); op.stream?.getTracks().forEach(t => t.stop()); };

/** One recorder and provider roster per draft; each operation owns its destination callback. */
export function useFeedbackSpeech(disabled: boolean) {
  const [phase, setPhase] = useState<"idle" | "starting" | "recording" | "transcribing">("idle"), [error, setError] = useState("");
  const [target, setTarget] = useState<string | null>(null);
  const active = useRef<Recording | null>(null);
  const { roster, error: rosterError } = useSpeechRoster(value => {
    if (active.current && (active.current.binding !== value?.binding || !value?.granted)) cancel();
  });
  useEffect(() => () => { dispose(active.current); active.current = null; }, []);
  // Recording cancellation synchronizes browser media resources with the disabled state.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { if (disabled) { dispose(active.current); active.current = null; setPhase("idle"); } }, [disabled]);
  const selected = roster && currentSpeechOption(roster);
  function cancel() { dispose(active.current); active.current = null; setPhase("idle"); }
  async function start(targetId: string, onText: (text: string) => void) {
    if (!roster?.binding || !selected?.available || disabled || active.current) return;
    const op: Recording = { binding: roster.binding, controller: new AbortController(), onText }; active.current = op;
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
            const wave = await recordingWave(new Blob(chunks, { type: recorder.mimeType }), 60); if (!valid()) return;
            const response = await appFetch("/api/speech/feedback?binding=" + encodeURIComponent(op.binding), { method: "POST", credentials: "include", signal: op.controller.signal,
              headers: { "content-type": "audio/wav" }, body: wave });
            const value = await response.json(); if (!response.ok) throw new Error(value.message ?? "Speech recognition failed.");
            if (valid()) { if (typeof value.text === "string" && value.text.trim()) op.onText(value.text.trim()); else setError("No speech detected."); }
          } catch (e) { if (valid()) setError(e instanceof Error ? e.message : "Speech recognition failed."); }
          finally { if (active.current === op) cancel(); }
        })();
      };
      recorder.start(1000); setPhase("recording"); op.timer = setTimeout(() => { if (recorder.state === "recording") recorder.stop(); }, 60_000);
    } catch (e) { if (valid()) { cancel(); setError(e instanceof Error ? e.message : "Microphone access failed."); } }
  }
  return { phase, target, error: error || rosterError, unavailable: roster && !selected?.available ? (!roster.granted ? "Speech input is not enabled for Harness." : roster.selected ? roster.selected.displayName + " is unavailable." : "Choose your dictation provider in Speech settings.") : null, available: !!selected?.available, start, cancel,
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
      title={speech.error || speech.unavailable || "Dictate up to one minute"}
      disabled={disabled || !speech.available || speech.phase !== "idle"} onClick={() => void speech.start(target, onText)}><Mic /></Button>}
  </div>;
}
