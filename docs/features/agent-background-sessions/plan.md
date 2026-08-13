# Agent Background Sessions

Status: Draft
Created: 2026-08-11
Updated: 2026-08-13

Make an assistant session findable and make it reach the operator when it needs them, so leaving an
agent working while you close the tab becomes a usable feature rather than a way to lose work.

Spans three features and belongs to none of them, so it links rather than duplicates:
[ai-gateway](../ai-gateway/feature.md) owns sessions, [notifications](../notifications.md) owns
delivery, and `apps/shell-swift` is the only client that can raise a real OS banner.

**No Core change.** Everything this needs already exists there — the notification store, service,
retention, SSE fan-out, and all three routes (`POST /api/internal/apps/{appId}/notifications` to
produce with a service token, `GET /api/notifications` and `POST /api/notifications/read` to read as
a session). This plan is entirely app- and client-side.

## Goal

Two gaps, one cause. The gateway already persists what it needs — session records plus an
append-only `events.ndjson` with a monotonic seq — and a closed panel deliberately does **not** stop
a running harness. But nothing surfaces that work:

- **A reloaded page loses the session.** `assistantSessionId` is plain `useState`
  (`apps/shell/src/app/shell-client.tsx:166`) with no persistence, so a reload starts a new session
  and abandons the old one — still running, now unreachable. `GET /api/sessions` exists in the
  gateway and Shell never calls it.
- **A paused session is silent.** An agent that stops on an approval or a question waits
  indefinitely, and the operator finds out only by opening the panel and looking.

The second is the sharper one, and it is what makes an agent session unlike the background jobs the
fleet already runs. A transcode has a defined end and deterministic progress; media-server persists
`Job` rows precisely so progress survives a restart, while the engines keep the live work in memory
(`TranscodeJob` and `MonoTorrentEngine` hold state in-process and report from there). An agent
session has no such shape: "running in the background" means **"waiting for you"** at least as often
as "working". A list that does not distinguish those is close to useless.

## Target Behavior

### A. Sessions are findable

- Shell persists the last session id, so a reload reattaches instead of orphaning it.
- A **session list**: title or first message, status, last activity, and — first — whether it is
  blocked on the operator. Sessions in `awaiting_approval` / `awaiting_question` sort above the rest,
  because "needs me" is the question the list exists to answer.
- Opening a listed session reattaches: the SSE replay already rebuilds the transcript and any pending
  approval or question card, so this is routing, not new session machinery.

### B. The attention signal

- A session waiting on the operator carries an indicator in the list **and** on the Assistant entry
  in the Shell sidebar, so it is visible without opening anything.
- The signal derives from session status alone. No new state: `awaiting_approval` and
  `awaiting_question` already exist and already drive the panel.

### C. Notifications

- On entering `awaiting_approval` or `awaiting_question`, the gateway publishes a user-targeted
  notification to Core with its service token — the one it already holds for audit reporting.
  `Link` points at the session.
- **`DedupeKey` identifies the wait, not the session** — session id plus the approval or question id.
  Keying on the session alone looked tidier and is wrong: Core suppresses a publish when an **unread**
  record with the same recipient, source and key exists, and an operator who answers in the panel
  never marks that record read. The next pause in the same session would then be silently swallowed,
  which is precisely the failure the notification exists to prevent. Per-wait keying still collapses
  duplicate publishes for the *same* wait, which is all dedupe was wanted for. Clearing the earlier
  record instead is not an option: the purge path is core-source only and unreachable by an app.
- **The Shell bell already exists** and needs nothing here: `notification-bell.tsx` reads
  `GET /api/notifications`, posts `/api/notifications/read`, and is rendered by the sidebar. An
  earlier draft of this plan listed building it, on the strength of [notifications](../notifications.md)
  still saying the bell "remains" — the document is stale, the code is not. Correcting that status is
  a deliverable below.
- **`apps/shell-swift` raises the real OS banner.** `CoreEventStream.swift` already models
  `case notification` and consumes the stream, so the transport exists; what is missing is
  `UNUserNotificationCenter`, which appears nowhere under `apps/shell-swift/` today, plus permission
  handling and opening the session from `Link` through the existing `ShellRouter`.

## Deliverables

- [ ] Shell persists the active session id across reloads.
- [ ] Shell session list backed by the gateway's existing `GET /api/sessions`, ordered with
      operator-blocked sessions first, with reattach on open.
- [ ] Attention indicator in the list and on the sidebar Assistant entry.
- [ ] Gateway publishes a notification on entering a waiting status, keyed by session for dedupe,
      linking to the session; nothing is published on resolution beyond clearing the state the UI
      reads.
- [ ] Correct [notifications](../notifications.md): its status still lists the Shell bell as
      outstanding although it shipped.
- [ ] Swift client: notification permission, `UNUserNotificationCenter` banner on the `notification`
      event, and `Link` navigation.
- [ ] `git mv docs/features/notifications.md docs/features/notifications/feature.md` — lazy migration,
      since this is the work that touches it — and split its outstanding items from its shipped
      reality.
- [ ] Docs: `feature.md` here, cross-links updated, index regenerated.

Version outcome: `apps/shell` minor, `apps/ai-gateway` minor, `apps/shell-swift` minor. No platform
change.

## Decisions

- **Native banners are macOS-only, deliberately** (2026-08-11, owner). The web Notifications API was
  considered and dropped: it requires a secure context, so a Shell opened over plain HTTP on a LAN
  address — a likely way to reach a home host — would silently have no notifications at all, and it
  needs a browser tab to stay open, which contradicts the point of background work. Windows and Linux
  operators get the Shell bell. That is an accepted platform asymmetry, not a gap to close later by
  surprise.
- **The gateway publishes; it does not deliver.** Notifications are a Core capability with many
  renderers, so the gateway must not grow its own path to Shell. Teaching it one would leave the
  native client and the CLI unable to see the same event.

## Open Questions

- Question: Should a *completed* background session notify, or only a blocked one?
  Answer: Completion is the weaker signal — the operator asked for the work and can find it in the
  list — while blocking is the one that stalls indefinitely and is invisible. But an agent that
  finishes a long job and says nothing is also a poor experience.
  Recommendation: blocked-only in v1, with completion reconsidered once the list exists and it is
  clear whether it already answers the question. Adding a notification later is cheap; training an
  operator to ignore a noisy one is not.

- Question: How long does an unattended session stay alive?
  Answer: There is a retention sweep (`HOSTY_AI_GATEWAY_RETENTION_DAYS`, default 30) for the record,
  but nothing bounds a *harness process* parked on an approval nobody answers. Each one holds a
  process and its context.
  Recommendation: cap the wait — after some hours in a waiting status, stop the harness and mark the
  session abandoned, leaving the transcript. Needs a number; it should come from watching real usage
  rather than being guessed here.

## Verification

- Gateway (vitest): a notification is published on entering each waiting status and not republished
  while the session stays there; **a second wait in the same session publishes again** even when the
  first notification was never read — the case per-wait keying exists for, and the one a session-keyed
  design fails silently; nothing is published when Core is
  unreachable beyond a logged failure — the assistant must keep working.
- Shell: verified live, since it has no unit tests — reload the page mid-session and confirm the same
  session reattaches with its pending card intact; confirm the sidebar indicator appears while a
  session waits and clears when it is answered.
- Swift: a session left waiting raises a banner with the app in the background, and clicking it opens
  that session. Permission-denied must degrade to the in-app bell rather than failing silently.
- **The attention path is verified by the signal clearing, not only by it appearing.** An indicator
  that never clears looks identical to a working one on first sight, and is worse than none — it
  trains the operator to ignore it.
