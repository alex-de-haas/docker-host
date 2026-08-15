# Notifications — Remaining Surfaces

Status: Draft
Created: 2026-06-16
Updated: 2026-08-15

The v1 backend, the consumer contract, live delivery, retention, and the Shell bell all ship — see
[feature.md](feature.md). What remains is exposing the same `NotificationService` to the clients that
are not a browser session, and the delivery channels that reach a user who is not looking at any client
at all.

Nothing here changes the consumer contract: it was shaped so each surface below is a thin wrapper over
the existing service rather than a redesign.

## Deliverables

- [ ] **Register the built-in `notifications` platform interface** so clients discover it uniformly
      instead of hardcoding the path:

      ```json
      { "interfaces": { "notifications": [{ "provider": "core", "endpoint": "http", "path": "/api/notifications" }] } }
      ```

      Externalizing later (a white-labeled delivery app, say) then swaps `"provider": "core"` for a
      system app with no consumer-contract change.
- [ ] **Core MCP facade** ([core-mcp](../core-mcp/feature.md)): resources `hosty://notifications`
      (+ `?unread=true`) and `hosty://notifications/unread-count` backing the `GET` data, plus a
      `mark_notification_read(ids?)` tool backing the read route. The **producer** endpoint is
      deliberately not an agent tool: apps produce, agents do not. The facade resolves the Hosty user
      from the presented credential and calls the service with that identity — the same scoping as the
      session consumer. Core MCP is admin-gated and read-only today, so this is the first mutation
      tool there and inherits that decision: shipping it means saying where its approval lives.
- [ ] **App read-back endpoint** for standalone-UI rendering, scoped to the app's own records:

      ```text
      GET /api/internal/apps/{appId}/notifications?user={userId}     # service token, source.appId == appId
      ```

      Optional and additive; the unified inbox stays a user surface.
- [ ] **Pluggable delivery channels** behind a `NotificationChannel` seam — email and web/mobile push —
      for the case the inbox cannot cover: nobody has a client open. Each channel needs its own
      retry and failure posture, which is why it is a seam rather than an inline call.
- [ ] Docs: fold each shipped surface into [feature.md](feature.md) and regenerate the index.

Not tracked here: the macOS OS banner on the `notification` event, which belongs to
[agent-background-sessions](../agent-background-sessions/plan.md) along with the gateway's use of the
producer endpoint. The transport it needs already exists.

Version outcome: platform minor for the interface registration, the MCP facade, and the read-back
endpoint.

## Open Questions

- Question: One JSON state document, or an NDJSON append-log?
  Answer: A single `JsonStorage` document matches `UserDirectoryStore` and is fine at single-host
  scale, but it is rewritten on every publish, and fan-out multiplies that by recipient count.
  Recommendation: keep the document; revisit an append-log with a read overlay only if notification
  volume becomes significant. Retention already bounds the file at 100 records per user.

- Question: Can a privileged **system app** emit `host-admin` notifications over HTTP?
  Answer: Not today — `host-admin` is in-process Core only, and system apps use `audience: "user"`.
  Recommendation: defer a privileged-producer scope until a concrete system-app need appears; it is a
  scope grant in [core-extension-model](../core-extension-model/plan.md) terms, not a special case in
  this endpoint.

- Question: Where do `Core → app` control signals live (lifecycle "you will be stopped",
  config-changed, token-rotated)?
  Answer: Not in this inbox. They are machine-targeted and need at-least-once delivery, retries, and
  idempotency.
  Recommendation: pull-based event subscriptions in
  [core-extension-model](../core-extension-model/plan.md), which revised the earlier webhook direction.

## Verification

- The interface registration is asserted through the same discovery path apps already read, not only
  by the registry's own unit test — a registered interface nobody can resolve is indistinguishable from
  an unregistered one.
- MCP resources return exactly what `GET /api/notifications` returns for the same actor, including the
  `host-admin` filtering, and the mutation tool is exercised end to end rather than only listed.
- The read-back endpoint refuses a foreign `source.appId` and a service token belonging to another app,
  with the permitted case asserted alongside — a route that refuses everything looks identical to a
  working gate.
- Channels are verified in the failing direction: a channel that is down must not lose the inbox record
  or block the publish.
