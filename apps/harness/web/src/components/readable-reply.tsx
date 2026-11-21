"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Square, Volume2 } from "lucide-react";
import { call } from "@/lib/api";
import { Markdown } from "./markdown";
import { MessageFooter } from "./message-footer";
import { Button } from "./ui/button";
import { playPcm, readableReplyText, speechChunks } from "@/lib/reply-audio";
import { currentSpeechOption, type SpeechRoster } from "../../../shared/speech-selection";

type Playback = { controller: AbortController; audio: AudioContext };
let stopCurrent: (() => void) | undefined;

export function ReadableReply({ text, sessionId, ts, recovered, incomplete }: {
  text: string; sessionId?: string; ts?: string; recovered?: boolean; incomplete?: boolean;
}) {
  const body = useRef<HTMLDivElement>(null), active = useRef<Playback | null>(null);
  const [playing, setPlaying] = useState(false), [error, setError] = useState("");
  const stop = useCallback(function stopPlayback() {
    const op = active.current; active.current = null;
    if (!op) return;
    op.controller.abort(); void op.audio.close().catch(() => {}); setPlaying(false);
    if (stopCurrent === stopPlayback) stopCurrent = undefined;
  }, []);
  useEffect(() => {
    window.addEventListener("pagehide", stop);
    return () => { window.removeEventListener("pagehide", stop); stop(); };
  }, [sessionId, text, stop]);
  async function read(section?: HTMLElement) {
    const chosen = body.current ? readableReplyText(body.current, section) : "";
    if (!sessionId || !chosen) return;
    stopCurrent?.(); setError("");
    let op: Playback | undefined;
    try {
      op = { controller: new AbortController(), audio: new AudioContext() };
      active.current = op; stopCurrent = stop; setPlaying(true);
      const signal = op.controller.signal;
      await op.audio.resume();
      const roster: SpeechRoster = await (await call("/speech/providers?kind=text-to-speech", { signal })).json();
      if (!roster.binding || !currentSpeechOption(roster)?.available)
        throw new Error(roster.selected ? roster.selected.displayName + " is unavailable." : "Choose a read-aloud provider in Speech settings.");
      const query = "binding=" + encodeURIComponent(roster.binding);
      const caps = await (await call("/speech/capabilities?kind=text-to-speech&" + query, { signal })).json();
      for (const chunk of speechChunks(chosen, caps.maxCharacters)) {
        signal.throwIfAborted();
        if (!chunk.trim()) continue;
        const response = await call("/speech/synthesis?" + query, {
          method: "POST", body: JSON.stringify({ text: chunk, sessionId }), signal,
        });
        await playPcm(response, op.audio, signal);
      }
    } catch (cause) {
      if (!op?.controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Audio playback failed.");
    } finally { if (op && active.current === op) stop(); }
  }
  const label = playing ? "Stop reading" : "Read aloud";
  return <div className="group/message flex flex-col gap-1">
    <div className="rounded-lg bg-muted/60 px-3 py-2">
      {recovered && <p className="mb-1 text-xs text-muted-foreground">Recovered from an earlier run</p>}
      <div ref={body}><Markdown text={text} onReadSection={sessionId ? section => void read(section) : undefined} /></div>
      {incomplete && <p className="mt-2 text-xs text-muted-foreground">Interrupted message</p>}
    </div>
    <MessageFooter text={text} ts={ts} active={playing}>
      {sessionId && text.trim() && <Button type="button" size="icon-sm" variant="ghost" aria-label={label} title={label}
        onClick={playing ? stop : () => void read()}>
        {playing ? <Square aria-hidden /> : <Volume2 aria-hidden />}
      </Button>}
    </MessageFooter>
    {error && <p role="alert" className="px-2 text-xs text-muted-foreground">{error} <a href="/settings/speech" className="underline">Speech settings</a></p>}
  </div>;
}
