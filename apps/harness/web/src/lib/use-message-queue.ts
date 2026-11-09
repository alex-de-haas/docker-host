"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { APP_SESSION_RESTORED } from "@hosty-sdk/app/browser-auth";
import { AssistantApiError, type AssistantEvent, type AssistantSession, type StoredAttachment } from "./assistant-api";
import { commandMessageQueue, getMessageQueue, uploadQueueAttachment, type MessageQueue, type QueueCommand, type QueueCommandInput } from "./message-queue-api";
import { listOutbox, outboxFiles, outboxScope, OUTBOX_CHANGED, removeOutbox, saveOutbox, stageOutbox, withOutboxLock, type OutboxEntry } from "./message-outbox";

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
type Snapshot = { sessionId: string; queue: MessageQueue };
type Operation = { scope: string; sessionId: string; input: QueueCommandInput };
const operationKey = (scope: string) => `hosty.message-queue.operation.${scope}`;
function readOperation(scope: string): Operation | null {
  const raw = localStorage.getItem(operationKey(scope)); if (!raw) return null;
  const value = JSON.parse(raw) as Operation;
  if (value.scope !== scope || !value.input?.requestId || !Number.isSafeInteger(value.input.expectedRevision) || !value.input.command?.type)
    throw new Error("Queue recovery details are unavailable. Refresh the queue before making another change.");
  return value;
}
function rememberOperation(value: Operation) {
  const key = operationKey(value.scope), raw = JSON.stringify(value);
  localStorage.setItem(key, raw);
  if (localStorage.getItem(key) !== raw) throw new Error("Could not save queue recovery details. The change was not sent.");
}
function forgetOperation(value: Operation) {
  if (readOperation(value.scope)?.input.requestId === value.input.requestId) localStorage.removeItem(operationKey(value.scope));
}

export function useMessageQueue(session: AssistantSession | null, ready: boolean) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [outbox, setOutbox] = useState<OutboxEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState<Operation | null>(null);
  const current = useRef(session);
  useLayoutEffect(() => { current.current = session; }, [session]);
  const latest = useRef<Snapshot | null>(null);
  const memory = useRef<OutboxEntry[]>([]);
  const queue = snapshot && snapshot.sessionId === session?.id ? snapshot.queue : null;
  const scope = queue && session ? outboxScope(queue.installationId, queue.ownerId, session.id) : null;
  const activeScope = useRef(scope);
  useLayoutEffect(() => { activeScope.current = scope; }, [scope]);
  const update = useCallback((sessionId: string, next: MessageQueue) => {
    if (current.current?.id !== sessionId || current.current.createdBy && current.current.createdBy !== next.ownerId) return;
    const previous = latest.current;
    if (previous?.sessionId === sessionId && previous.queue.revision > next.revision) return;
    const value = { sessionId, queue: next }; latest.current = value; setSnapshot(value);
  }, []);
  const refresh = useCallback(async () => {
    const id = current.current?.id, owner = current.current?.createdBy; if (!id) return null;
    const active = () => current.current?.id === id && current.current.createdBy === owner;
    try {
      const next = await getMessageQueue(id);
      if (!active()) return null;
      if (current.current?.createdBy && current.current.createdBy !== next.ownerId) throw new AssistantApiError("queue_owner_changed", "Sign in as the conversation owner.", 403);
      update(id, next); return next;
    } catch (cause) {
      if (!active()) return null;
      if (cause instanceof AssistantApiError && [401, 403, 404].includes(cause.status ?? 0)) { latest.current = null; setSnapshot(null); setOutbox([]); }
      throw cause;
    }
  }, [update]);
  const receive = useCallback((event: AssistantEvent) => {
    if (event.type === "session_message_queue" && event.queue && typeof event.queue === "object" && current.current)
      update(current.current.id, event.queue as MessageQueue);
  }, [update]);
  const context = JSON.stringify([ready, session?.id, session?.createdBy]);
  const [previousContext, setPreviousContext] = useState(context);
  if (previousContext !== context) { setPreviousContext(context); setSnapshot(null); setOutbox([]); setOperation(null); setError(null); setBusy(false); }
  useLayoutEffect(() => { latest.current = null; }, [context]);
  useEffect(() => {
    const id = current.current?.id;
    if (!ready || !id) return;
    const reload = () => { void refresh().catch(cause => { if (current.current?.id === id) setError(message(cause)); }); };
    reload();
    window.addEventListener(APP_SESSION_RESTORED, reload); window.addEventListener("online", reload);
    return () => { window.removeEventListener(APP_SESSION_RESTORED, reload); window.removeEventListener("online", reload); };
  }, [ready, context, refresh]);

  const loadLocal = useCallback(async (key: string) => {
    try {
      const rows = await listOutbox(key);
      if (activeScope.current === key) setOutbox([...rows, ...memory.current.filter(row => row.scope === key)]);
    } catch (cause) {
      if (activeScope.current === key) {
        setOutbox(previous => [...previous.filter(row => row.scope === key && row.durable !== false), ...memory.current.filter(row => row.scope === key)]);
        if (typeof indexedDB !== "undefined") setError(`Could not read saved local messages: ${message(cause)}`);
      }
    }
  }, []);
  const flush = useCallback(async (key: string, sessionId: string) => {
    await withOutboxLock(key, async () => {
      let persisted: OutboxEntry[];
      try { persisted = await listOutbox(key); }
      catch (cause) { if (typeof indexedDB !== "undefined") throw cause; persisted = []; }
      const rows = [...persisted, ...memory.current.filter(row => row.scope === key)].sort((a, b) => a.sequence - b.sequence);
      for (const row of rows) {
        if (row.error) break;
        const persist = async () => {
          if (memory.current.includes(row)) { await loadLocal(key); return; }
          await saveOutbox(row);
        };
        try {
          let observed = await getMessageQueue(sessionId);
          if (outboxScope(observed.installationId, observed.ownerId, sessionId) !== key) throw new Error("Sign in as the queue owner before restoring this message.");
          if (activeScope.current === key) update(sessionId, observed);
          for (const file of row.files) {
            if (!file.stored) { file.stored = await uploadQueueAttachment(sessionId, file.id, file.name, file.bytes); await persist(); }
          }
          // Save the exact command before POST. Unknown replies replay this identity and payload.
          for (let conflict = 0; ; conflict++) {
            row.command ??= { requestId: crypto.randomUUID(), expectedRevision: observed.revision, command: {
              type: "enqueue", entryId: row.id, text: row.text,
              attachments: [...row.attachments, ...row.files.flatMap(file => file.stored ? [file.stored] : [])].map(file => file.name),
              ...(row.promptSuggestions ? { promptSuggestions: true } : {}), ...(row.withoutAppDetails ? { withoutAppDetails: true } : {}),
            } };
            await persist();
            try {
              const reply = await commandMessageQueue(sessionId, row.command); if (activeScope.current === key) update(sessionId, reply.queue); break;
            } catch (cause) {
              if (cause instanceof AssistantApiError && cause.code === "queue_entry_exists") break;
              if (!(cause instanceof AssistantApiError) || cause.code !== "queue_revision_conflict") throw cause;
              row.command = undefined; await persist();
              if (conflict >= 2) throw cause;
              observed = await getMessageQueue(sessionId);
              if (outboxScope(observed.installationId, observed.ownerId, sessionId) !== key) throw new Error("Queue owner changed.");
            }
          }
          if (memory.current.includes(row)) memory.current = memory.current.filter(value => value !== row);
          else await removeOutbox(key, row.id);
          await loadLocal(key);
        } catch (cause) {
          row.error = message(cause); await persist();
          if (activeScope.current === key) setError(null); // Error belongs to its own row.
          break;
        }
      }
    });
  }, [loadLocal, update]);
  useEffect(() => {
    const id = current.current?.id;
    if (!scope || !id) return;
    void loadLocal(scope); void flush(scope, id).catch(cause => { if (activeScope.current === scope) setError(message(cause)); });
    void Promise.resolve().then(() => readOperation(scope)).then(value => { if (activeScope.current === scope) setOperation(value); })
      .catch(cause => { if (activeScope.current === scope) setError(message(cause)); });
    const changed = (event: Event) => { if ((event as CustomEvent).detail === scope) void loadLocal(scope); };
    window.addEventListener(OUTBOX_CHANGED, changed);
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("hosty.message-queue");
    if (channel) channel.onmessage = event => { if (event.data === scope) { void loadLocal(scope); void refresh().catch(() => {}); } };
    const changedAcrossTabs = () => { channel?.postMessage(scope); };
    window.addEventListener(OUTBOX_CHANGED, changedAcrossTabs);
    return () => { window.removeEventListener(OUTBOX_CHANGED, changed); window.removeEventListener(OUTBOX_CHANGED, changedAcrossTabs); channel?.close(); };
  }, [scope, loadLocal, flush, refresh]);

  const enqueue = useCallback(async (input: { text: string; draftText: string; files: File[]; attachments: StoredAttachment[]; promptSuggestions?: boolean; withoutAppDetails?: boolean }) => {
    if (!scope || !session || !queue) throw new Error("Wait for the message queue to connect.");
    if (memory.current.some(row => row.scope === scope)) throw new Error("Retry the previous unsaved message first.");
    const { files, ...rest } = input;
    const value: Omit<OutboxEntry, "sequence"> = { ...rest, files: outboxFiles(files), id: crypto.randomUUID(), scope, sessionId: session.id };
    try { await stageOutbox(value); }
    catch {
      // A storage-denied browser keeps its composer snapshot until server acceptance.
      const row: OutboxEntry = { ...value, sequence: Date.now(), durable: false }; memory.current.push(row); await loadLocal(scope);
      await flush(scope, session.id);
      if (memory.current.includes(row)) throw new Error(row.error ?? "The message has not reached the server. Your draft is retained.");
      return;
    }
    await loadLocal(scope); void flush(scope, session.id).catch(cause => { if (activeScope.current === scope) setError(message(cause)); });
  }, [scope, session, queue, loadLocal, flush]);

  const perform = useCallback(async (command?: QueueCommand) => {
    if (!scope || !session || !queue) throw new Error("Wait for the message queue to connect.");
    const active = () => activeScope.current === scope;
    return withOutboxLock(`command:${scope}`, async () => {
      if (active()) { setBusy(true); setError(null); }
      let pending: Operation | null = null;
      try {
        pending = readOperation(scope);
        if (pending && command) throw new Error("Retry the previous queue change first.");
        if (!pending) {
          if (!command) return null;
          const observed = await getMessageQueue(session.id); if (active()) update(session.id, observed);
          if (outboxScope(observed.installationId, observed.ownerId, session.id) !== scope) throw new Error("Queue owner changed.");
          pending = { scope, sessionId: session.id, input: { requestId: crypto.randomUUID(), expectedRevision: observed.revision, command } };
          rememberOperation(pending); if (active()) setOperation(pending);
        }
        const reply = await commandMessageQueue(session.id, pending.input); if (active()) update(session.id, reply.queue);
        forgetOperation(pending); if (active()) setOperation(null); return reply;
      } catch (cause) {
        if (pending && cause instanceof AssistantApiError && cause.status && cause.status >= 400 && cause.status < 500
          && ![401, 403].includes(cause.status)) {
          forgetOperation(pending); if (active()) { setOperation(null); void refresh().catch(() => {}); }
        }
        if (active()) setError(message(cause)); throw cause;
      } finally { if (active()) setBusy(false); }
    });
  }, [scope, session, queue, refresh, update]);
  const retryLocal = useCallback(async (id: string) => {
    if (!scope || !session) return;
    const row = (await listOutbox(scope).catch(() => [])).find(row => row.id === id) ?? memory.current.find(row => row.scope === scope && row.id === id);
    if (!row) return;
    row.error = undefined;
    if (!memory.current.includes(row)) await saveOutbox(row);
    await flush(scope, session.id); await loadLocal(scope);
    return row.durable === false && !memory.current.includes(row) ? row : undefined;
  }, [scope, session, flush, loadLocal]);
  const refreshAll = async () => {
    await refresh();
    const key = activeScope.current, id = current.current?.id;
    if (key && id) { await loadLocal(key); await flush(key, id); }
  };
  return { queue, scope, outbox: scope ? outbox.filter(row => row.scope === scope) : [], error, busy, operation, enqueue, perform, retryLocal, receive, refresh: refreshAll };
}
