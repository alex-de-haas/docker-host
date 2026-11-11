"use client";

import { useEffect, useState, type SetStateAction } from "react";
import { loadPromptTemplates, type PromptTemplate } from "./prompt-templates-api";

/** Load on each opening; never share personal prompt bodies between users or composer mounts. */
export function usePromptTemplatePicker(open: boolean, search: string) {
  const [attempt, setAttempt] = useState(0);
  const [request, setRequest] = useState({ open, attempt, epoch: 0 });
  if (request.open !== open || request.attempt !== attempt) setRequest({ open, attempt, epoch: request.epoch + 1 });
  const [result, setResult] = useState<{ epoch: number; templates: PromptTemplate[]; error: string | null } | null>(null);
  const [selection, setSelection] = useState({ epoch: 0, search, index: 0 });
  const epoch = request.epoch;
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void loadPromptTemplates().then(collection => { if (!cancelled) setResult({ epoch, templates: collection.templates, error: null }); })
      .catch(cause => { if (!cancelled) setResult({ epoch, templates: [], error: cause instanceof Error ? cause.message : "Could not load prompt templates." }); });
    return () => { cancelled = true; };
  }, [open, epoch]);
  const ready = open && result?.epoch === epoch;
  const templates = ready ? result.templates : [];
  const error = ready ? result.error : null;
  const loading = open && !ready;
  const active = selection.epoch === epoch && selection.search === search ? selection.index : 0;
  const setActive = (value: SetStateAction<number>) => setSelection({ epoch, search, index: typeof value === "function" ? value(active) : value });
  const query = search.trim().toLowerCase();
  const matches = templates.filter(template => !query || template.shortcut.toLowerCase().includes(query) || template.name.toLowerCase().includes(query));
  return { templates: matches, empty: !templates.length, loading, error, active, setActive, retry: () => setAttempt(n => n + 1) };
}
