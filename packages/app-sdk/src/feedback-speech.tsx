"use client";
import { useEffect, useRef, useState } from "react";
import { appFetch } from "./browser-auth";
import { recordingWave } from "./feedback-audio";
type Provider = { appId: string; key: string; displayName: string; available: boolean };
type Recording = { controller: AbortController; stream?: MediaStream; recorder?: MediaRecorder; timer?: ReturnType<typeof setTimeout> };
const dispose = (op: Recording | null) => { if (!op) return; op.controller.abort(); clearTimeout(op.timer); if (op.recorder?.state === "recording") op.recorder.stop(); op.stream?.getTracks().forEach(t => t.stop()); };

export function FeedbackSpeech({ path, disabled, onText, onBusyChange }: { path: string; disabled: boolean; onText: (text: string) => void; onBusyChange: (busy: boolean) => void }) {
  const [providers, setProviders] = useState<Provider[]>([]), [choice, setChoice] = useState("");
  const [phase, setPhase] = useState("idle"), [error, setError] = useState("");
  const active = useRef<Recording | null>(null), result = useRef(onText); result.current = onText;
  const endpoint = path + "/speech";
  useEffect(() => { onBusyChange(phase !== "idle"); return () => onBusyChange(false); }, [phase, onBusyChange]);
  useEffect(() => {
    const abort = new AbortController();
    void appFetch(endpoint, { credentials: "include", signal: abort.signal }).then(async response => {
      const value = await response.json(); if (!response.ok) throw new Error(value.message ?? "Speech input is unavailable.");
      if (!abort.signal.aborted) { setProviders(value.providers ?? []); if (!value.granted) setError("Speech input is not enabled for this application."); }
    }).catch(e => { if (!abort.signal.aborted) setError(e.message); });
    return () => { abort.abort(); dispose(active.current); active.current = null; };
  }, [endpoint]);
  useEffect(() => { if (disabled) { dispose(active.current); active.current = null; setPhase("idle"); } }, [disabled]);
  const selected = providers.find(p => JSON.stringify([p.appId, p.key]) === choice) ?? (providers.length === 1 ? providers[0] : undefined);
  function cancel() { dispose(active.current); active.current = null; setPhase("idle"); }
  async function start() {
    if (!selected?.available || disabled || active.current) return;
    const op: Recording = { controller: new AbortController() }; active.current = op;
    const valid = () => active.current === op && !op.controller.signal.aborted;
    setPhase("starting"); setError("");
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") throw new Error("This browser cannot record audio here. Type your comment instead.");
      op.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!valid()) { dispose(op); return; }
      const recorder = new MediaRecorder(op.stream); op.recorder = recorder; const chunks: Blob[] = []; let bytes = 0;
      recorder.ondataavailable = e => { bytes += e.data.size; if (bytes > 16 * 1024 * 1024) { cancel(); setError("Recording is too large. Try a shorter comment."); } else if (e.data.size) chunks.push(e.data); };
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
            if (valid()) { if (typeof value.text === "string" && value.text.trim()) result.current(value.text.trim()); else setError("No speech detected."); }
          } catch (e) { if (valid()) setError(e instanceof Error ? e.message : "Speech recognition failed."); }
          finally { if (active.current === op) cancel(); }
        })();
      };
      recorder.start(1000); setPhase("recording"); op.timer = setTimeout(() => { if (recorder.state === "recording") recorder.stop(); }, 60_000);
    } catch (e) { if (valid()) { cancel(); setError(e instanceof Error ? e.message : "Microphone access failed."); } }
  }
  return <div className="hf-speech">
    {providers.length > 1 && <label>Speech provider<select value={choice} disabled={phase !== "idle" || disabled} onChange={e => setChoice(e.target.value)}><option value="">Choose provider</option>{providers.map(p => <option key={JSON.stringify([p.appId, p.key])} value={JSON.stringify([p.appId, p.key])} disabled={!p.available}>{p.displayName}</option>)}</select></label>}
    {phase === "idle" ? <button disabled={disabled || !selected?.available} title={error || "Dictate up to one minute"} onClick={() => void start()}>Dictate</button>
      : <><button disabled={phase !== "recording"} onClick={() => active.current?.recorder?.stop()}>{phase === "recording" ? "Stop and transcribe" : phase === "starting" ? "Opening microphone…" : "Transcribing…"}</button><button onClick={cancel}>Cancel dictation</button></>}
    {error && <small role="status">{error}</small>}
  </div>;
}
