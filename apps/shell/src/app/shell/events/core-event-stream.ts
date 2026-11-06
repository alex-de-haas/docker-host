"use client";
import { APP_ACTIVITY_RENEWED } from "@hosty-sdk/app/browser-auth";

// One connection per Core in this browser context. Most events remain refresh hints; resource
// consumers opt into sequenced data and own their HTTP/buffer reconciliation during synchronization.
export const CoreEventNames = {
  sandboxSnapshot: "sandbox.snapshot",
  resourcesChanged: "resources.changed",
  resourcesSample: "resources.sample",
  appChanged: "app.changed",
  workspaceChanged: "workspace.changed",
  appRemoved: "app.removed",
  appUpdateCheckChanged: "app.update-check.changed",
  fleetUpdateCheckChanged: "apps.update-check.changed",
  notification: "notification",
  toolActivityChanged: "tool.activity.changed",
} as const;
export type CoreEventName = (typeof CoreEventNames)[keyof typeof CoreEventNames];
export type CoreStreamState = "connecting" | "stream" | "legacy" | "error" | "inactive";
export interface CoreEventSubscription {
  names: readonly CoreEventName[];
  onSync: () => void | Promise<void>;
  onEvent?: (name: CoreEventName, data: unknown) => void;
  syncDebounceMs?: number;
  /** Optional high-volume or source metadata interest exists only while the page is visible. */
  topic?: "resources" | "workspaces" | "tool-activity" | "sandboxes";
  onStreamState?: (state: CoreStreamState) => void;
  /** The consumer buffers/reconciles payloads itself instead of fetching again for every event. */
  receiveWhileSyncing?: boolean;
}
interface Subscriber extends CoreEventSubscription {
  syncing: boolean;
  resyncPending: boolean;
  disposed: boolean;
  debounceTimer: ReturnType<typeof setTimeout> | null;
}
interface Connection {
  source: EventSource | null;
  topics: string;
  capabilities: Record<string, unknown>;
  state: CoreStreamState;
  pageActive: boolean;
  subscribers: Set<Subscriber>;
  acknowledgementTimer: ReturnType<typeof setTimeout> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  retryAttempt: number;
  disposeVisibility: () => void;
}
const connections = new Map<string, Connection>();
const active = (connection: Connection, subscriber: Subscriber) => !subscriber.disposed && connection.pageActive &&
  (!subscriber.topic || document.visibilityState === "visible");

async function runSync(subscriber: Subscriber): Promise<void> {
  if (subscriber.disposed) return;
  if (subscriber.receiveWhileSyncing) {
    // Payload consumers own single-flight/cancellation alongside their event buffer. A cancelled
    // generation must not hold up a new connection, and overlapping lifecycle signals need no
    // queued second read once the consumer has reconciled its buffered frames.
    try { await subscriber.onSync(); } catch { /* Consumer-owned recovery. */ }
    return;
  }
  if (subscriber.syncing) { subscriber.resyncPending = true; return; }
  subscriber.syncing = true;
  try { await subscriber.onSync(); } catch { /* The consumer owns recovery and error presentation. */ }
  finally {
    subscriber.syncing = false;
    if (subscriber.resyncPending) { subscriber.resyncPending = false; void runSync(subscriber); }
  }
}
function scheduleSync(subscriber: Subscriber) {
  if (subscriber.debounceTimer !== null) clearTimeout(subscriber.debounceTimer);
  subscriber.debounceTimer = setTimeout(() => {
    subscriber.debounceTimer = null;
    void runSync(subscriber);
  }, subscriber.syncDebounceMs ?? 300);
}
function clearAcknowledgement(connection: Connection) {
  if (connection.acknowledgementTimer !== null) clearTimeout(connection.acknowledgementTimer);
  connection.acknowledgementTimer = null;
}
function subscriberState(connection: Connection, subscriber: Subscriber): CoreStreamState {
  if (!active(connection, subscriber)) return "inactive";
  const capability = subscriber.topic === "tool-activity" ? "toolActivity" : subscriber.topic;
  return connection.state === "stream" && capability && connection.capabilities[capability] !== 1 ? "legacy" : connection.state;
}
function setState(connection: Connection, state: CoreStreamState) {
  connection.state = state;
  for (const subscriber of connection.subscribers) {
    subscriber.onStreamState?.(subscriberState(connection, subscriber));
  }
}
function acknowledge(connection: Connection, state: "stream" | "legacy") {
  clearAcknowledgement(connection);
  if (connection.state === state) return;
  setState(connection, state);
  for (const subscriber of connection.subscribers) {
    if (subscriber.topic && active(connection, subscriber)) void runSync(subscriber);
  }
}
function closeConnection(connection: Connection) {
  clearAcknowledgement(connection);
  if (connection.retryTimer !== null) clearTimeout(connection.retryTimer);
  connection.retryTimer = null;
  connection.source?.close();
  connection.source = null;
}
function reconcile(connection: Connection, force = false): boolean {
  const subscribers = [...connection.subscribers].filter(s => active(connection, s));
  const topics = [...new Set(subscribers.flatMap(s => s.topic ? [s.topic] : []))].sort().join(",");
  if (!force && connection.source && connection.source.readyState !== EventSource.CLOSED && topics === connection.topics) return false;
  closeConnection(connection);
  connection.topics = topics;
  connection.capabilities = {};
  if (!subscribers.length) { setState(connection, "inactive"); return true; }
  setState(connection, "connecting");
  let source: EventSource;
  try { source = new EventSource(`/api/core/api/events${topics ? `?topics=${topics}` : ""}`, { withCredentials: true }); }
  catch { setState(connection, "error"); return true; }
  connection.source = source;
  const current = () => connection.source === source;
  source.onopen = () => {
    if (!current()) return;
    connection.retryAttempt = 0;
    clearAcknowledgement(connection);
    setState(connection, "connecting");
    for (const subscriber of connection.subscribers) {
      if (!subscriber.topic && active(connection, subscriber)) void runSync(subscriber);
    }
    // Old Core ignores the query. Only an OPEN stream without the additive acknowledgement can
    // select compatibility polling; network errors never turn a supported stream into polling.
    if (topics) connection.acknowledgementTimer = setTimeout(() => acknowledge(connection, "legacy"), 2000);
  };
  source.addEventListener("stream.ready", event => {
    if (!current()) return;
    try {
      const capabilities = JSON.parse((event as MessageEvent).data);
      if (capabilities && typeof capabilities === "object") {
        connection.capabilities = capabilities;
        // Capabilities belong to each consumer: an older Core lacking sandbox data must not
        // turn supported resource delivery back into polling on this same connection.
        acknowledge(connection, "stream");
      }
    } catch { /* Ignore malformed capability messages. */ }
  });
  for (const name of Object.values(CoreEventNames)) source.addEventListener(name, event => {
    if (!current()) return;
    let payload: unknown = null;
    try { payload = JSON.parse((event as MessageEvent).data); } catch { /* Consumer can request recovery. */ }
    for (const subscriber of connection.subscribers) {
      if (!active(connection, subscriber) || !subscriber.names.includes(name)) continue;
      if (subscriber.onEvent && (!subscriber.syncing || subscriber.receiveWhileSyncing)) subscriber.onEvent(name, payload);
      else scheduleSync(subscriber);
    }
  });
  source.onerror = () => {
    if (!current()) return;
    clearAcknowledgement(connection);
    setState(connection, "error");
    // An optional subscriber may release its interest and replace this source on error.
    if (!current()) return;
    // EventSource retries interrupted streams, but a proxy's HTTP 502/503 can leave it CLOSED.
    // Retry those with capped backoff too; otherwise a Core restart strands a visible Dashboard.
    // This is connection recovery only: no resource GET runs until a stream opens and acknowledges.
    if (source.readyState === EventSource.CLOSED && connection.retryTimer === null) {
      const delays = [1000, 3000, 10_000, 30_000];
      const delay = delays[Math.min(connection.retryAttempt++, delays.length - 1)];
      connection.retryTimer = setTimeout(() => {
        connection.retryTimer = null;
        if (current()) reconcile(connection, true);
      }, delay);
    }
  };
  return true;
}
function getConnection(coreOrigin: string): Connection {
  const existing = connections.get(coreOrigin);
  if (existing) return existing;
  const connection: Connection = { source: null, topics: "", capabilities: {}, state: "inactive", pageActive: true,
    subscribers: new Set(), acknowledgementTimer: null, retryTimer: null, retryAttempt: 0, disposeVisibility: () => {} };
  let wasVisible = document.visibilityState === "visible";
  const onVisibility = () => {
    const visible = document.visibilityState === "visible";
    if (visible === wasVisible) return;
    wasVisible = visible;
    for (const subscriber of connection.subscribers) {
      if (!active(connection, subscriber)) subscriber.onStreamState?.("inactive");
    }
    if (!reconcile(connection) && document.visibilityState === "visible") {
      for (const subscriber of connection.subscribers) if (active(connection, subscriber)) void runSync(subscriber);
    }
  };
  const onRenewed = () => {
    reconcile(connection, true);
    for (const subscriber of connection.subscribers) if (!subscriber.topic && active(connection, subscriber)) void runSync(subscriber);
  };
  const onPageHide = () => { connection.pageActive = false; reconcile(connection, true); };
  const onPageShow = (event: PageTransitionEvent) => {
    if (!event.persisted && connection.pageActive) return;
    connection.pageActive = true;
    reconcile(connection, true);
  };
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener(APP_ACTIVITY_RENEWED, onRenewed);
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("pageshow", onPageShow);
  connection.disposeVisibility = () => {
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener(APP_ACTIVITY_RENEWED, onRenewed);
    window.removeEventListener("pagehide", onPageHide);
    window.removeEventListener("pageshow", onPageShow);
  };
  connections.set(coreOrigin, connection);
  return connection;
}
export function subscribeToCoreEvents(coreOrigin: string, subscription: CoreEventSubscription): () => void {
  if (typeof window === "undefined") return () => {};
  const connection = getConnection(coreOrigin);
  const subscriber: Subscriber = { ...subscription, syncing: false, resyncPending: false, disposed: false, debounceTimer: null };
  connection.subscribers.add(subscriber);
  const reopened = reconcile(connection);
  // Hint consumers historically load immediately, even if opening the stream fails. Resource
  // consumers instead wait for acknowledgement so subscription precedes their single history read.
  if (!subscriber.topic && active(connection, subscriber)) void runSync(subscriber);
  if (!reopened) {
    subscriber.onStreamState?.(subscriberState(connection, subscriber));
    if (subscriber.topic && active(connection, subscriber) && connection.source?.readyState === EventSource.OPEN &&
      (connection.state === "stream" || connection.state === "legacy")) void runSync(subscriber);
  }
  return () => {
    if (subscriber.disposed) return;
    subscriber.disposed = true;
    if (subscriber.debounceTimer !== null) clearTimeout(subscriber.debounceTimer);
    subscriber.onStreamState?.("inactive");
    connection.subscribers.delete(subscriber);
    if (connection.subscribers.size) reconcile(connection);
    else {
      closeConnection(connection);
      connection.disposeVisibility();
      connections.delete(coreOrigin);
    }
  };
}
