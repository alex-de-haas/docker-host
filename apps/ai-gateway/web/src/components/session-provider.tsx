"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  listAgentConnections,
  setSessionProvider,
  type AssistantSession,
} from "@/lib/assistant-api";
import type { AgentConnection } from "./agent-providers";

export function SessionProvider({
  session,
  busy,
  onChange,
}: {
  session: AssistantSession;
  busy: boolean;
  onChange(record: AssistantSession): void;
}) {
  const [connections, setConnections] = useState<AgentConnection[]>([]);
  const [selected, setSelected] = useState(session.connectionId ?? "");
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked =
    session.providerLocked === true && Boolean(session.connectionId);
  const legacy = session.providerLocked === true && !session.connectionId;
  useEffect(() => {
    let disposed = false;
    const refresh = () =>
      void listAgentConnections()
        .then((result) => {
          if (!disposed) setConnections(result.connections);
        })
        .catch((e) => {
          if (!disposed) setError(e.message);
        });
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      disposed = true;
      window.removeEventListener("focus", refresh);
    };
  }, [session.id]);
  const current = connections.find((c) => c.id === session.connectionId);
  return (
    <div className="grid shrink-0 gap-2 border-b px-3 py-2 text-xs">
      {locked ? (
        <p className="text-muted-foreground">
          {current?.name ??
            `${session.harnessKind ?? "Provider"} · connection removed or unavailable`}
          {current && current.revision !== session.connectionRevision
            ? " · credentials changed; start a new chat"
            : " · selected for this chat"}
        </p>
      ) : (
        <>
          <div className="flex gap-2">
            <label className="flex min-w-0 flex-1 items-center gap-2">
              Provider
              <select
                className="min-w-0 flex-1 rounded-md border bg-background p-1.5"
                value={selected}
                disabled={busy || saving}
                onChange={(event) => {
                  setSelected(event.target.value);
                  setConfirmed(false);
                }}
              >
                <option value="">Choose a provider</option>
                {connections.map((c) => (
                  <option key={c.id} value={c.id} disabled={!c.available}>
                    {c.name}
                    {c.available ? "" : " (reconnect required)"}
                  </option>
                ))}
              </select>
            </label>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || saving || !selected || (legacy && !confirmed)}
              onClick={async () => {
                setSaving(true);
                setError(null);
                try {
                  onChange(
                    await setSessionProvider(session.id, selected, confirmed),
                  );
                } catch (e) {
                  setError(
                    e instanceof Error
                      ? e.message
                      : "Could not select provider.",
                  );
                } finally {
                  setSaving(false);
                }
              }}
            >
              {saving ? "Saving…" : "Select"}
            </Button>
          </div>
          {legacy && (
            <label className="flex gap-2 text-muted-foreground">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              This older chat used the selected provider and account. Resume it
              with that connection.
            </label>
          )}
          {!connections.length && !error && (
            <p className="text-muted-foreground">
              Add a provider in AI Gateway settings.
            </p>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
