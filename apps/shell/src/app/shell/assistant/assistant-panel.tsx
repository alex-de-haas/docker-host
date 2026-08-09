"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, RotateCcw, Send, Sparkles, Wrench } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { Alert, InlineError, StatusBadge } from "../ui";
import {
  AssistantClient,
  type AssistantEvent,
  type AssistantGateway,
  type AssistantSession,
  type HarnessHealth,
} from "./assistant-client";

// The operator chat surface (docs/features/ai-gateway/plan.md, phase 3): admin-only, rendered only
// when a running app declares the ai-gateway interface. The transcript is the gateway's event log;
// every proposed write pauses as an inline approval card until the operator decides.

type AssistantPanelProps = {
  gateway: AssistantGateway;
  coreOrigin: string;
  /** Structured page context ("app", "page") seeding the first message; never parsed by the model. */
  context: Record<string, string> | null;
  /** The session the panel last held. Closing the panel never stops the harness run, so reopening
   * must reattach here instead of orphaning the old session behind a brand-new one. */
  sessionId: string | null;
  onSessionId: (sessionId: string | null) => void;
  onClose: () => void;
  sendCsrfJson: (endpoint: string, body?: unknown, method?: string) => Promise<Response>;
};

export function AssistantPanel({
  gateway,
  coreOrigin,
  context,
  sessionId,
  onSessionId,
  onClose,
  sendCsrfJson,
}: AssistantPanelProps) {
  const client = useMemo(
    () =>
      new AssistantClient(gateway.baseUrl, async () => {
        // sendCsrfJson already throws on non-2xx; this guards the shape so a drifted Core
        // response can never seed the token cache with undefined fields.
        const response = await sendCsrfJson(
          `${coreOrigin}/api/apps/${encodeURIComponent(gateway.appId)}/delegated-token`,
        );
        const issued = (await response.json().catch(() => null)) as {
          token?: unknown;
          expiresAt?: unknown;
        } | null;
        if (typeof issued?.token !== "string" || typeof issued.expiresAt !== "string") {
          throw new Error("Core returned an unexpected delegated-token response.");
        }
        return { token: issued.token, expiresAt: issued.expiresAt };
      }),
    [gateway.baseUrl, gateway.appId, coreOrigin, sendCsrfJson],
  );

  const [health, setHealth] = useState<HarnessHealth | null>(null);
  const [session, setSession] = useState<AssistantSession | null>(null);
  const [status, setStatus] = useState<string>("idle");
  const [events, setEvents] = useState<AssistantEvent[]>([]);
  const [draft, setDraft] = useState("");
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const contextSentRef = useRef(false);
  const streamAbortRef = useRef<AbortController | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  const startSession = useCallback(async (forceNew = false) => {
    streamAbortRef.current?.abort();
    setEvents([]);
    setDraft("");
    setError(null);
    setSession(null);
    setStatus("idle");
    contextSentRef.current = false;
    try {
      const harness = await client.health();
      setHealth(harness);
      if (!harness.available) {
        return;
      }

      // Reattach first: closing the panel only dropped the SSE connection — the harness run (and
      // any pending approval) is still live on the gateway. The stream replays the transcript from
      // seq 0, which also rebuilds unresolved approval cards.
      let active: AssistantSession | null = null;
      if (!forceNew && sessionId) {
        active = await client.getSession(sessionId).catch(() => null);
        if (active) {
          contextSentRef.current = true;
        }
      }
      if (!active) {
        active = await client.createSession(context ? { context } : {});
        onSessionId(active.id);
      }
      setSession(active);
      setStatus(active.status);

      const abort = new AbortController();
      streamAbortRef.current = abort;
      void client.streamEvents(
        active.id,
        (event) => {
          if (event.type === "assistant_delta") {
            setDraft((current) => current + String(event.text ?? ""));
            return;
          }
          if (event.type === "assistant_text") {
            setDraft("");
          }
          if (event.type === "session_status") {
            setStatus(String(event.status ?? "idle"));
            return;
          }
          setEvents((current) => [...current, event]);
        },
        abort.signal,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [client, context, sessionId, onSessionId]);

  // The mount effect goes through a ref: startSession's identity changes when the parent learns
  // the created session id, and re-running the effect then would tear the fresh stream down just
  // to reattach to the same session.
  const startSessionRef = useRef(startSession);
  useEffect(() => {
    startSessionRef.current = startSession;
  }, [startSession]);
  useEffect(() => {
    if (gateway.running) {
      void startSessionRef.current();
    }
    return () => streamAbortRef.current?.abort();
  }, [gateway.running]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight });
  }, [events, draft]);

  const send = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || !session || sending) {
      return;
    }

    // The context is structured on the session record; the model sees it once, as a plain header
    // line on the first message — the prompt itself stays free-form.
    let text = trimmed;
    if (context && !contextSentRef.current) {
      const header = Object.entries(context)
        .map(([key, value]) => `${key}=${value}`)
        .join(", ");
      text = `[Hosty context: ${header}]\n\n${trimmed}`;
      contextSentRef.current = true;
    }

    setSending(true);
    setError(null);
    try {
      await client.postMessage(session.id, text);
      setInput("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  }, [client, context, input, sending, session]);

  const decide = useCallback(
    async (approvalId: string, decision: "allow" | "deny") => {
      if (!session) {
        return;
      }
      try {
        await client.resolveApproval(session.id, approvalId, decision);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [client, session],
  );

  const decidedApprovals = useMemo(() => {
    const decisions = new Map<string, string>();
    for (const event of events) {
      if (event.type === "approval_decision") {
        decisions.set(String(event.approvalId), String(event.decision));
      }
    }
    return decisions;
  }, [events]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="top-4 right-4 bottom-4 left-auto h-auto max-h-none w-[440px] max-w-[calc(100vw-2rem)] translate-x-0 translate-y-0 gap-3 p-4 sm:max-w-[440px]"
        aria-describedby={undefined}
      >
        <DialogHeader className="pr-8">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4" aria-hidden />
            Assistant
            <StatusBadge value={status} />
          </DialogTitle>
          <DialogDescription className="flex items-center gap-2 text-xs">
            {context ? (
              <Badge variant="outline" className="max-w-full truncate font-normal">
                {Object.entries(context)
                  .map(([key, value]) => `${key}: ${value}`)
                  .join(" · ")}
              </Badge>
            ) : (
              <span>Operator session on this host — every write asks first.</span>
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              title="New session"
              aria-label="New session"
              className="ml-auto"
              onClick={() => void startSession(true)}
            >
              <RotateCcw />
            </Button>
          </DialogDescription>
        </DialogHeader>

        <div ref={transcriptRef} className="-mx-4 min-h-0 flex-1 space-y-3 overflow-y-auto px-4">
          {!gateway.running && (
            <Alert
              severity="warning"
              title="The AI Gateway app is not running."
              detail="Start hosty.ai-gateway from the dashboard to use the assistant."
            />
          )}
          {gateway.running && health && !health.available && (
            <Alert severity="warning" title="Assistant unavailable" detail={health.reason} />
          )}
          {error && <InlineError message={error} />}

          {events.map((event) => (
            <TranscriptEvent
              key={event.seq}
              event={event}
              decision={
                event.type === "approval_request"
                  ? decidedApprovals.get(String(event.approvalId)) ?? null
                  : null
              }
              onDecide={decide}
            />
          ))}
          {draft && (
            <div className="rounded-lg bg-muted/60 px-3 py-2 text-sm whitespace-pre-wrap">
              {draft}
              <Loader2 className="ml-1 inline h-3 w-3 animate-spin text-muted-foreground" aria-hidden />
            </div>
          )}
        </div>

        <form
          className="flex shrink-0 items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            rows={2}
            placeholder={session ? "Ask the operator assistant…" : "Waiting for the gateway…"}
            disabled={!session || sending}
            className="flex-1 resize-none rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
          />
          <Button type="submit" size="icon" disabled={!session || sending || !input.trim()} aria-label="Send">
            {sending ? <Loader2 className="animate-spin" /> : <Send />}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TranscriptEvent({
  event,
  decision,
  onDecide,
}: {
  event: AssistantEvent;
  decision: string | null;
  onDecide: (approvalId: string, decision: "allow" | "deny") => Promise<void>;
}) {
  switch (event.type) {
    case "user_message":
      return (
        <div className="ml-8 rounded-lg bg-primary/10 px-3 py-2 text-sm whitespace-pre-wrap">
          {String(event.text ?? "")}
        </div>
      );
    case "assistant_text":
      return (
        <div className="rounded-lg bg-muted/60 px-3 py-2 text-sm whitespace-pre-wrap">
          {String(event.text ?? "")}
        </div>
      );
    case "tool_use":
      return (
        <div className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
          <Wrench className="h-3 w-3" aria-hidden />
          {String(event.toolName ?? "tool")}
        </div>
      );
    case "approval_request": {
      const approvalId = String(event.approvalId);
      return (
        <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          <div className="font-medium">Approve {String(event.toolName ?? "action")}?</div>
          <pre className="max-h-32 overflow-auto rounded bg-background/60 p-2 text-xs whitespace-pre-wrap">
            {JSON.stringify(event.input ?? {}, null, 2)}
          </pre>
          {decision ? (
            <Badge variant="outline" className={cn(decision === "allow" ? "text-emerald-700" : "text-destructive")}>
              {decision === "allow" ? "Allowed" : "Denied"}
            </Badge>
          ) : (
            <div className="flex gap-2">
              <Button type="button" size="sm" onClick={() => void onDecide(approvalId, "allow")}>
                Allow
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => void onDecide(approvalId, "deny")}>
                Deny
              </Button>
            </div>
          )}
        </div>
      );
    }
    case "error":
      return <InlineError message={String(event.message ?? "Assistant error")} />;
    case "result":
    case "session_created":
    case "approval_decision":
    case "status":
      return null;
    default:
      return null;
  }
}
