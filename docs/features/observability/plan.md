# Observability — Remaining Work

Status: Draft
Created: 2026-07-03
Updated: 2026-07-25

## Goal

Close the three gaps left after the telemetry store, query API, and UI moved out of Core into the
`hosty.telemetry` system app (see [feature.md](feature.md) for what runs today): the telemetry data
path has **no auth of its own**, live tails still **poll**, and the fleet-wide views that were
promised alongside the per-app ones — a Dashboard heat-map and trace→log correlation — were never
built.

Security comes first. The rest is freshness and reach.

## Target behavior

A diff against [feature.md](feature.md):

- The Query API section no longer says the API carries no auth. The backend requires a credential
  Core mints and injects, on both the query port and OTLP ingest, and rejects unauthenticated callers
  — so a local process can neither read the fleet's telemetry nor inject spans attributed to another
  app.
- Logs and traces reach the UI as they arrive rather than on a poll: the backend exposes a stream
  endpoint and the UI's Structured logs and Traces pages tail it live, with the poll retained as the
  fallback when the stream drops.
- Stored OTLP log records link to the trace they belong to, and a trace's spans link back to the log
  records carrying the same `trace_id` — the ids are already stored on both sides, only the
  navigation is missing.
- A fleet heat-map summarizes per-app health/CPU/memory at a glance, over a single summary read
  rather than a fan-out per app.

## Deliverables

- [ ] **Ingest + query auth.** Core mints a shared credential for the telemetry app and injects it
      the same way it injects the OTLP endpoint; the backend requires it on the query port, and OTLP
      ingest requires it per app so `hosty.app.id` can no longer be spoofed. Remove the
      "known-open" `SECURITY` note in `apps/telemetry-backend/src/Haas.Hosty.TelemetryBackend/Program.cs`
      and the corresponding paragraph in `feature.md` when this lands.
- [ ] **Backend stream endpoint.** An SSE (or equivalent) endpoint over new log records and spans,
      filterable by the same `apps` / `severity` / `q` parameters as the query reads.
- [ ] **UI live tail.** Structured logs and Traces consume the stream through the UI's server routes;
      reconnect and backfill on drop; Metrics stay on the existing poll (charts do not benefit).
- [ ] **trace→log correlation links** in the telemetry UI, both directions.
- [ ] **Fleet heat-map** plus the single summary endpoint that backs it, once its home is decided
      (open question 3).

## Phases

1. **Auth.** The credential, both enforcement points, and the tests that prove an unauthenticated
   caller is refused. Independently shippable and the highest-value item — everything else adds
   surface to a data path that is currently open.
2. **Realtime.** Backend stream endpoint, then the UI tail. Depends on phase 1 only in that a new
   endpoint should not ship unauthenticated.
3. **Fleet views.** trace→log links and the heat-map. Independent of 1–2; the heat-map is blocked on
   open question 3.

## Open questions

1. **Credential shape.** A shared secret Core injects into both the telemetry app and every
   OTLP-producing app (simple, but a static secret every app holds), versus per-app tokens validated
   by the backend against a Core-injected verification key (stronger — it makes ingest attribution
   provable — at the cost of key distribution and rotation). The platform rule in
   [ai-agent-bridge.md](../ai-agent-bridge.md#authorization-and-delegation) favours the latter for
   anything streaming or high-volume, which ingest is.
2. **Does this wait for the network hardening?** The shared internal-only docker network tracked in
   [cross-app-dependencies.md](../cross-app-dependencies/feature.md) would take ingest and the query port off
   the host/LAN, which is the other half of the fix. Auth should not block on it — "internal" has
   already proven to be a boundary Hosty does not actually provide (C-M10) — but the two overlap
   enough that sequencing is worth a decision.
3. **Where does the fleet heat-map live?** It was scoped as a Shell Dashboard element, but Shell no
   longer has any route to telemetry data: the Core read proxy is gone and Shell holds no observability
   code. So a Dashboard heat-map means either resurrecting a Core proxy (against the direction of
   travel) or giving Shell a direct backend read; putting it on the telemetry UI keeps the data path
   clean but takes it off the landing page, where its value is. Undecided.
4. **Streaming through the UI's server routes.** The browser can only reach the UI origin — the
   backend's query port is not published — so the UI's Next route handlers have to relay the stream.
   Long-lived streaming responses through a Next route handler need checking against the app's
   runtime (flush per event, no buffering, cancellation tied to the client disconnect).

## Verification

- Backend tests: an unauthenticated query is refused, an authenticated one succeeds, ingest rejects
  an unattributable or spoofed producer, and the stream endpoint emits the records a matching query
  would return.
- Core tests: the credential is minted and injected at start and does not leak to the collector
  (a third-party image), matching how the docker-stats scrape token is handled today.
- Live host: with the telemetry app running, a fresh app log record appears in the Structured logs
  page without a manual refresh; killing the stream falls back to polling and recovers on reconnect;
  a direct `curl` of the query port from the host is refused.
- `node scripts/docs-index.mjs --check` passes, and `feature.md` is updated in the same PR that
  completes each deliverable.
