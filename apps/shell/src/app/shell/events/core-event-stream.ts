"use client";

// Client for Core's unified event stream (GET /api/events).
//
// The bus stores nothing: events are hints ("re-read this"), never records of what happened. A Core
// restart drops everything in flight and a disconnected client misses events until it reconnects, so
// the whole delivery guarantee is the subscriber contract — connect, resync through the API, then
// react — repeated on every reconnect. That is why `onSync` is required rather than optional: a
// subscriber that only listened would silently serve stale data after any gap.
//
// One EventSource per origin, shared by every subscriber. Browsers cap concurrent HTTP/1.1
// connections per origin at ~6, and a stream is long-lived — a connection per component would spend
// that budget on duplicates of the same data.
//
// This module is written in the shape the SDK slice (`@hosty-sdk/app/events`) will publish once
// app-facing subscriptions ship, so migrating is a move rather than a redesign.

export const CoreEventNames = {
  appChanged: "app.changed",
  appRemoved: "app.removed",
  appUpdateCheckChanged: "app.update-check.changed",
  fleetUpdateCheckChanged: "apps.update-check.changed",
  notification: "notification",
} as const;

export type CoreEventName = (typeof CoreEventNames)[keyof typeof CoreEventNames];

const ALL_EVENT_NAMES: readonly CoreEventName[] = Object.values(CoreEventNames);

export interface CoreEventSubscription {
  /** Event names this subscriber cares about. */
  names: readonly CoreEventName[];
  /**
   * Re-read the state this subscriber renders. Called on connect, on every reconnect, when the tab
   * becomes visible again, and (debounced) after matching events. Never optional — see above.
   */
  onSync: () => void | Promise<void>;
  /**
   * Optional fast path for subscribers that can apply an event's payload directly instead of
   * waiting for the resync. Delivered only while a sync is not in flight; otherwise the event
   * collapses into another sync, because a payload applied on top of half-read state is a bug.
   */
  onEvent?: (name: CoreEventName, data: unknown) => void;
  /** Debounce for event-triggered syncs; multi-step operations commit several times in a row. */
  syncDebounceMs?: number;
}

const DEFAULT_SYNC_DEBOUNCE_MS = 300;

interface Subscriber extends CoreEventSubscription {
  syncing: boolean;
  resyncPending: boolean;
  debounceTimer: ReturnType<typeof setTimeout> | null;
}

interface Connection {
  source: EventSource | null;
  subscribers: Set<Subscriber>;
  disposeVisibility: () => void;
}

const connections = new Map<string, Connection>();

// Runs the subscriber's resync, collapsing overlapping requests. An event that lands while a sync is
// in flight schedules exactly one more pass afterwards: the running sync may already have read state
// from before that change.
async function runSync(subscriber: Subscriber): Promise<void> {
  if (subscriber.syncing) {
    subscriber.resyncPending = true;
    return;
  }

  subscriber.syncing = true;
  try {
    await subscriber.onSync();
  } catch {
    // A failed resync is not fatal: the next event, the next visibility change, or the caller's own
    // error handling covers it. Never surface transport noise as a shell-level error.
  } finally {
    subscriber.syncing = false;
    if (subscriber.resyncPending) {
      subscriber.resyncPending = false;
      void runSync(subscriber);
    }
  }
}

function scheduleSync(subscriber: Subscriber): void {
  if (subscriber.debounceTimer !== null) {
    clearTimeout(subscriber.debounceTimer);
  }

  subscriber.debounceTimer = setTimeout(() => {
    subscriber.debounceTimer = null;
    void runSync(subscriber);
  }, subscriber.syncDebounceMs ?? DEFAULT_SYNC_DEBOUNCE_MS);
}

function openConnection(coreOrigin: string, connection: Connection): void {
  if (connection.source !== null) {
    return;
  }

  let source: EventSource;
  try {
    source = new EventSource(`${coreOrigin}/api/events`, { withCredentials: true });
  } catch {
    // No EventSource (or it refused to construct): subscribers keep whatever polling fallback they
    // have. Nothing here is load-bearing enough to surface.
    return;
  }

  connection.source = source;

  // Every (re)connect starts the contract over. The browser reconnects on its own after a drop, and
  // this fires again — that is exactly when a client is most likely to be stale.
  source.onopen = () => {
    for (const subscriber of connection.subscribers) {
      void runSync(subscriber);
    }
  };

  for (const name of ALL_EVENT_NAMES) {
    source.addEventListener(name, (event) => {
      let payload: unknown = null;
      try {
        payload = JSON.parse((event as MessageEvent).data as string);
      } catch {
        payload = null;
      }

      for (const subscriber of connection.subscribers) {
        if (!subscriber.names.includes(name)) {
          continue;
        }

        if (subscriber.onEvent && !subscriber.syncing) {
          subscriber.onEvent(name, payload);
          continue;
        }

        scheduleSync(subscriber);
      }
    });
  }

  source.onerror = () => {
    // The browser retries on its own; a closed source (e.g. the session died) is reopened on the
    // next visibility change. Staying silent is deliberate — the shell's normal fetches own auth
    // redirects and error reporting.
  };
}

function getConnection(coreOrigin: string): Connection {
  const existing = connections.get(coreOrigin);
  if (existing) {
    return existing;
  }

  const connection: Connection = { source: null, subscribers: new Set(), disposeVisibility: () => {} };

  // A backgrounded tab can miss events entirely (throttled timers, a proxy reaping the idle
  // connection). Returning to it is a resync point, and a chance to reopen a source the browser gave
  // up on.
  const onVisibility = () => {
    if (document.visibilityState !== "visible") {
      return;
    }

    if (connection.source === null || connection.source.readyState === EventSource.CLOSED) {
      connection.source?.close();
      connection.source = null;
      openConnection(coreOrigin, connection);
    }

    for (const subscriber of connection.subscribers) {
      void runSync(subscriber);
    }
  };

  document.addEventListener("visibilitychange", onVisibility);
  connection.disposeVisibility = () => document.removeEventListener("visibilitychange", onVisibility);
  connections.set(coreOrigin, connection);
  return connection;
}

/**
 * Subscribe to Core's event stream. Returns an unsubscribe function; the shared connection closes
 * once the last subscriber leaves.
 */
export function subscribeToCoreEvents(coreOrigin: string, subscription: CoreEventSubscription): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }

  const connection = getConnection(coreOrigin);
  const subscriber: Subscriber = {
    ...subscription,
    syncing: false,
    resyncPending: false,
    debounceTimer: null,
  };
  connection.subscribers.add(subscriber);
  openConnection(coreOrigin, connection);

  // A subscriber that joins an already-open connection missed its own `onopen`, so it syncs here.
  void runSync(subscriber);

  return () => {
    if (subscriber.debounceTimer !== null) {
      clearTimeout(subscriber.debounceTimer);
    }

    connection.subscribers.delete(subscriber);
    if (connection.subscribers.size === 0) {
      connection.source?.close();
      connection.source = null;
      connection.disposeVisibility();
      connections.delete(coreOrigin);
    }
  };
}
