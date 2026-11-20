"use client";
import { useEffect, useEffectEvent, useState } from "react";
import type { SpeechRoster } from "../../../shared/speech-selection";
import { call } from "./api";

/** Refresh on entry and focus; a slower read for the previous account cannot win. */
export function useSpeechRoster(onChange: (value: SpeechRoster | null) => void) {
  const [roster, setRoster] = useState<SpeechRoster | null>(null);
  const [error, setError] = useState("");
  const changed = useEffectEvent(onChange);
  useEffect(() => {
    let latest: AbortController | undefined;
    async function refresh() {
      latest?.abort();
      const op = new AbortController(); latest = op;
      try {
        const next = await (await call("/speech/providers", { signal: op.signal })).json() as SpeechRoster;
        if (!op.signal.aborted) { setRoster(next); setError(""); changed(next); }
      } catch (cause) {
        if (!op.signal.aborted) {
          setRoster(null); changed(null);
          setError(cause instanceof Error ? cause.message : "Speech providers are unavailable.");
        }
      }
    }
    void refresh(); window.addEventListener("focus", refresh);
    return () => { latest?.abort(); window.removeEventListener("focus", refresh); };
  }, []);
  return { roster, error };
}
