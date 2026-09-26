"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { findAssistantGateways, selectAssistant, type AssistantGateway } from "./assistant-client";
import type { CoreApp } from "../types";

/** Shell owns this per-user preference; an invalid stored id is deliberately retained. */
export function useAssistantSelection(apps: CoreApp[], scope: string | null) {
  const assistants = useMemo(() => findAssistantGateways(apps), [apps]);
  const key = scope ? `hosty.shell.assistant.${encodeURIComponent(scope)}` : null;
  const [openKey, setOpenKey] = useState<string | null>(null);
  const pending = useRef<((assistant: AssistantGateway | null) => void) | null>(null);
  const subscribe = useCallback((notify: () => void) => {
    window.addEventListener("hosty:assistant-preference", notify);
    return () => window.removeEventListener("hosty:assistant-preference", notify);
  }, []);
  const snapshot = useCallback((): string | null | undefined => {
    if (!key) return undefined;
    const encoded = document.cookie.split("; ").find(item => item.startsWith(`${key}=`))?.slice(key.length + 1);
    try { return encoded ? decodeURIComponent(encoded) : null; } catch { return "invalid"; }
  }, [key]);
  const preference = useSyncExternalStore(subscribe, snapshot, () => undefined);
  useEffect(() => () => { pending.current?.(null); pending.current = null; }, [key]);
  const ready = preference !== undefined;
  const selectedId = preference ?? null;
  const selected = ready ? selectAssistant(assistants, selectedId) : null;
  const select = useCallback((id: string) => {
    if (!key || !assistants.some(app => app.appId === id)) return;
    document.cookie = `${key}=${encodeURIComponent(id)}; path=/; max-age=31536000; samesite=lax`;
    window.dispatchEvent(new Event("hosty:assistant-preference"));
  }, [key, assistants]);
  const choose = useCallback(async (): Promise<AssistantGateway | null> => {
    if (!ready || !assistants.length) return null;
    if (selected) return selected;
    pending.current?.(null);
    setOpenKey(key);
    return new Promise(resolve => { pending.current = resolve; });
  }, [ready, assistants, selected, key]);
  const close = () => { pending.current?.(null); pending.current = null; setOpenKey(null); };
  const picker = <Dialog open={key !== null && openKey === key} onOpenChange={value => { if (!value) close(); }}>
    <DialogContent><DialogHeader><DialogTitle>Choose an assistant</DialogTitle>
      <DialogDescription>Shell sends this request to the assistant you select. You can change the choice in Settings → Shell.</DialogDescription>
    </DialogHeader><div className="flex flex-col gap-2">{assistants.map(assistant => <Button key={assistant.appId} variant="outline" disabled={!assistant.running} onClick={() => {
      select(assistant.appId); pending.current?.(assistant); pending.current = null; setOpenKey(null);
    }}>{apps.find(app => app.id === assistant.appId)?.displayName || assistant.appId}{!assistant.running ? " — unavailable" : ""}</Button>)}</div>
    </DialogContent>
  </Dialog>;
  return { assistants, selectedId, selected, select, choose, picker };
}
