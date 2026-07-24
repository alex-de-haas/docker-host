# Core Event Bus — Ephemeral Domain Events Over A Unified SSE Stream

Created: 2026-07-24
Updated: 2026-07-24

Core runs an in-process event bus and serves it to session clients over one Server-Sent Events
endpoint. Clients use it to learn that something changed and re-read it, which is how the Shell
Installed Apps page stays current without polling.

## Semantics: hints, not facts

The bus stores nothing. Durability belongs to the data — the app registry, `NotificationStore`,
`AuditStore` — never to the transport:

- The source of truth is always the Core API. An event says "re-read this", it is not a record of
  what happened, and it carries no state beyond the id of the app it concerns.
- A Core restart drops everything in flight. A disconnected subscriber misses events until it
  reconnects. A slow subscriber loses its oldest buffered events.
- **Subscriber contract:** open the stream, resync through the API, then react — repeated on every
  reconnect. There is no replay, no cursor and no `Last-Event-ID`, because reconnecting already
  re-reads the truth.

The one thing this cannot serve is a consumer whose correctness depends on never missing a
*transition* that leaves no trace in durable state — "run X after every crash" automation, say. Such
a consumer does not exist today, and the cases that look like it are covered by durable state
(restart counts in health, audit entries, undelivered notifications).

## Hub

`CoreEventHub` fans out to per-subscriber bounded channels (64, drop-oldest). Publishing never
blocks: callers publish while holding locks — the `AppRegistryStore` per-app mutex, the sweep's own
gate — so back-pressure from a stalled reader would deadlock real work. When nobody is subscribed,
publishing skips serialization entirely.

Each event is serialized once per publish, not once per subscriber, and travels as a named SSE frame:

```text
event: app.changed
data: {"name":"app.changed","appId":"com.haas.demo-app","occurredAt":"2026-07-24T15:00:00Z"}
```

## Events

| Name | Published when |
| ---- | -------------- |
| `app.changed` | Any app record is committed — install, any lifecycle verb, a supervisor `RuntimeState` flip, a reconcile. |
| `app.removed` | An app record is deleted. |
| `app.update-check.changed` | An app's update-availability verdict changes. |
| `apps.update-check.changed` | The fleet update sweep starts or finishes. |
| `notification` | A notification is published for the subscriber (payload: the same view `GET /api/notifications` returns). |

`app.changed` does not distinguish create from update: consumers re-read the list either way, and the
distinction is available at the publish point if a consumer ever needs it.

## Publish points

Two choke points carry every domain event, so no caller has to remember to announce anything:

- **`AppRegistryStore.UpsertAppCoreAsync`** — the private method both public writers
  (`UpsertAppAsync`, `UpdateAppAsync`) funnel into, covering all of `CoreLifecycleService`'s write
  sites by construction. `RemoveAppAsync` publishes `app.removed`.
- **`CoreLifecycleService.SetUpdateAvailability` / `ClearUpdateAvailability`** — the update-check
  projection's own choke point. Verdicts live in an in-memory dictionary and never reach `AppRecord`,
  so the store's `app.changed` does not cover them; routing every write through these two helpers
  covers sweep results, dialog-open re-plans, refresh probes and the post-apply reset alike.

`AppUpdateSweepService` publishes its own run-state transitions. The start is announced from inside
the sweep task, but the **finish rides a continuation that runs after the task completes**, because
`Status` derives `running` from that very task: announcing from within it would point clients at a
status still saying `running: true`, leaving the spinner turning. The task itself is never cleared
from inside itself either — single-flight in `Trigger`/`RunAsync` is keyed on it, so doing that would
open a window in which a second concurrent sweep could start.

## Endpoint

```text
GET /api/events        # Core session; named events; live-only
```

One stream carries both domain events and the session's notifications, so a tab opens one connection
rather than two against a browser's ~6-per-origin cap. The endpoint authenticates with the Core
session cookie, which is what makes it reachable from `EventSource` (no custom headers possible), and
fans out per subscriber: notifications go to their recipient, **domain events only to admin
sessions**. That gate is real access control, not tidiness — `GET /api/apps` filters itself per user,
so broadcasting app ids to every session would leak the existence of apps a user was never assigned.

The stream writes an initial `: connected` comment so proxies forward the response start with real
body bytes, sends `: ping` every 20s to stay under Cloudflare's ~100s origin timeout, and links its
cancellation to `ApplicationStopping` — an SSE response never completes on its own, so without that
link one open tab holds Kestrel's graceful stop for the full shutdown budget and starves the
runtime-app stop sweep behind it.

Shell is the only subscriber. There is no app-facing subscription or producer endpoint; apps neither
read nor write the bus. [core-extension-model](../../ideas/core-extension-model.md) is where that
possibility is tracked, and its durable-log design would attach to this hub as one more subscriber
rather than change what exists here.

## Shell consumer

`subscribeToCoreEvents` (`apps/shell/src/app/shell/events/core-event-stream.ts`) owns one
`EventSource` per origin, shared by every subscriber in the tab. Its API makes the subscriber
contract structural: `onSync` is required, runs on connect, on every browser reconnect, when the tab
becomes visible again, and — debounced 300 ms — after matching events. An event that lands while a
sync is in flight collapses into one follow-up sync instead of being applied on top of half-read
state. Subscribers that can use a payload directly (the notification bell) pass an optional
`onEvent`. The module is shaped like the SDK slice it becomes if app-facing subscriptions ever ship.

`ShellClient` subscribes for admin sessions and reacts by re-reading `GET /api/apps` only — the one
response every domain event can affect — without touching `loading`, so another operator's action
never flickers the list. The notification bell subscribes for `notification`, applying payloads
directly and keeping `GET /api/notifications` (30s) as the fallback when the stream is unavailable.

Non-admin sessions hold no domain-event subscription: Core does not fan those out to them, so the
launcher list refreshes on navigation and on demand as before.

## Testing Expectations

- Hub: per-user notification fan-out, admin-only domain fan-out (the leak guard), drop-oldest under
  a stalled reader, and disposal completing the reader.
- Publish points: both public store writers emit `app.changed` and removal emits `app.removed`,
  proving the choke point rather than the call sites; a store constructed without a hub still
  commits.
- Endpoint: anonymous callers get 401, the initial comment and idle heartbeat are written, domain
  events reach an admin session and are withheld from a non-admin one, and the stream ends on
  `ApplicationStopping` — the regression guard for the shutdown-starvation class.
- The endpoint-authorization harness enumerates every mapped route, so this one is covered against
  losing its session gate.
