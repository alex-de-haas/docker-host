# Telemetry Over MCP

Status: Draft
Created: 2026-08-17
Updated: 2026-08-17

Give an agent the fleet's **stored** telemetry — searchable logs and traces — as MCP tools, and put a
credential in front of that data first.

## Goal

Close the gap Core MCP's own tool description admits:

> `tail_app_logs` — "Returns the tail of one app's console output. **This is a live tail, not a
> searchable log store** — ask for more lines rather than expecting to filter."

`apps/telemetry-backend` already serves what is missing — `/api/observability/logs` filtered by time
range, severity, app set and substring, plus `/traces` and `/traces/{traceId}`. Nothing reaches it
but the telemetry UI.

The motivating case is diagnosing a production host: *"get me the logs from prod"*. That works today
only by opening the telemetry UI in a browser.

## The Blocker This Plan Absorbs

The backend's query API **carries no authentication at all**, and its own source says so with a
standing instruction:

> Any local process can read the fleet's telemetry and inject spoofed spans/metrics attributed to any
> `hosty.app.id`. **Do not add functionality that assumes a trust boundary here** until Core mints a
> credential for query + ingest.

An MCP interface is exactly such functionality: the app-MCP contract is "Core authenticates, the app
authorizes" ([app-mcp](../app-mcp/feature.md)), which an app with no authentication cannot honour.
Shipping the tools first would produce either an unauthenticated MCP endpoint — the
"unauthenticated remote API wearing a protocol" that contract exists to forbid — or a gated MCP
endpoint beside an open REST one, which is the appearance of control rather than control.

[observability](../observability/plan.md) already ranks this first for the same reason ("everything
else adds surface to a data path that is currently open"). **That plan's auth deliverable moves here**
rather than being duplicated; this plan owns it and observability links to it.

## Decisions

- **Per-app tokens, not a shared secret** (owner, 2026-08-17). Settles open question 1 of the
  observability plan. A static secret every OTLP-producing app holds makes attribution unprovable —
  any app could claim to be any other — and rotation means restarting the fleet.

- **A new asymmetric app-identity credential, added beside the existing one rather than replacing
  it.** Established by reading the code rather than assumed:
  `AppServiceSigningKey` is **HMAC — symmetric**. Handing it to the telemetry backend so it can
  verify callers would also let it *mint* a token for any app, which destroys the attribution
  per-app tokens are for.
  Converting the existing token to asymmetric was the tempting alternative and is rejected: the key
  is durable and a token minted by a previous Core must keep validating across a restart — that
  requirement exists because a stale service token after a light restart already broke app→Core calls
  once. Changing the algorithm under adopted containers would repeat it.
  So: Core mints an additional Core-signed, app-scoped token and injects the **public half** into
  verifiers, exactly as `HOSTY_DELEGATED_TOKEN_PUBLIC_KEY` already works. Additive, and an app started
  by an older Core simply lacks it and is refused, which is legible.

- **Two credential shapes at the query API, because there are two kinds of caller.** An app calling
  it (the telemetry UI) presents its app identity. A *user* calling it through MCP presents a
  short-TTL delegated token, which is the ordinary app-MCP contract. The backend accepts both and
  says which it saw.

- **Reading requires an administrator** (owner, 2026-08-17), and it needs no new check to enforce.
  `apps/telemetry` is `role: system`, and `RequireAccessibleUserAsync` already refuses a non-admin on
  a system app — so Core will not mint a delegated token for the telemetry backend for anyone else.
  The rule is therefore inherited rather than reimplemented, which is the version that cannot drift.
  Worth asserting in a test anyway: it holds today by a property of another feature, and nothing in
  telemetry would notice if that property changed.

## Deliverables

- [ ] **Query auth on the telemetry backend.** Core-injected verification key; every
      `/api/observability/*` route refuses an unauthenticated caller. Tests prove the refusal **beside**
      an accepted call of each shape, since a backend that refuses everything passes the refusal alone.
- [ ] **The telemetry UI presents its credential**, so the existing surface keeps working — verified
      by loading it, not by inspection.
- [ ] **Bind the OTLP port to `127.0.0.1`** — drop `"expose": "host"` from
      `apps/telemetry/manifest.json`.
- [ ] **A shared `hosty-telemetry-net`**: the collector joins it, every telemetry-enabled container
      joins it, and the injected `OTEL_EXPORTER_OTLP_ENDPOINT` points at the collector's alias rather
      than `host.docker.internal`. `localCommand` apps keep the loopback endpoint they already get.
      A container that starts before the network exists, or an app whose telemetry is switched on later,
      must end up attached rather than quietly exporting nowhere — the failure mode here is silence.
- [ ] **No ingest credential**, per the decision below. The deliverable is that ingest is unreachable
      off-host, proved by checking the published binding rather than by reading the manifest.
- [ ] **`interfaces.mcp` on telemetry-backend**, validating a delegated token exactly as demo-app
      does, with the app's own authorization applied per tool.
- [ ] **Tools**: `search_logs` (time range, severity, apps, substring), `list_traces`, `get_trace`.
      All declare `readOnlyHint: true` — without it the connector's fail-closed filter exports nothing,
      which [hosty-mcp-connector](../hosty-mcp-connector/feature.md) demonstrated the hard way.
- [ ] **Truncation is reported, never silent.** The store's query path clamps range and row count, and
      a burst has already hidden real data behind exactly that: a 1-hour maximum plus a newest-500
      limit made an app logging ~2k/h look quiet. Every result says what window and what cap produced
      it, and whether rows were dropped — an agent that cannot see the clamp will report "no errors"
      when it means "none in the newest 500".
- [ ] Docs: `feature.md`, observability's auth deliverable replaced by a link here, index.

Version outcome: platform minor (new Core credential, and the telemetry network), `apps/telemetry`
minor.

## Open Questions

None.

- **The OTLP port stops being published off-host, and ingest needs no credential of its own**
  (owner, 2026-08-17). Two parts, because there are two kinds of producer:
  `127.0.0.1` for the OTLP bind, which is all a `localCommand` app needs — it runs as a host process
  and already receives the loopback endpoint unchanged; and a dedicated **`hosty-telemetry-net`** that
  the collector and every telemetry-enabled *container* join, reached by network alias instead of
  `host.docker.internal`.
  Then writing is open to installed apps and to nothing else, which is the intended model rather than
  a description of it — and there is no ingest auth to build, on a third-party binary that could not
  have enforced per-app tokens anyway.
  The premise this corrects is worth recording, because it was the obvious one and it was wrong: the
  port is not exposed for *frontend* apps. Nothing in Hosty emits OTLP from a browser — the `OTEL_*`
  variables Core injects are server-side. `"expose": "host"` exists so **containers** can reach the
  collector, since `host.docker.internal` resolves to a bridge-gateway address that cannot reach a
  loopback-bound port on Linux. That is also why "just bind loopback" alone would have silently
  stopped ingest from every containerised app.
  Rejected: leaving `0.0.0.0` and adding a static bearer on the collector — weaker than the query side
  and it would have to say so in the same breath; having apps forward telemetry through their own
  backend, which does not generalise, since the containers that cannot reach loopback *are* the app
  backends and no extra hop puts the collector in their reach; and waiting for the general
  [cross-app-dependencies](../cross-app-dependencies/feature.md) network, which needs a policy for who
  may talk to whom, where telemetry is one well-defined one-way case that does not.
  The mechanism is not new: Core already creates a per-app user network when services `dependsOn` one
  another and lets them find each other by service-name DNS with no host publishing. This is that,
  spanning apps for one purpose.

## Verification

- The refusal and the acceptance as a pair, for each credential shape.
- Live, against the running host: ask an agent for errors in a named window and confirm the answer
  matches what the telemetry UI shows for the same window — a tool that silently queried a different
  range would otherwise look correct.
- The truncation case deliberately: query a window whose row count exceeds the cap and confirm the
  result says so rather than presenting the newest rows as the whole story.
- **Ingest still works after the bind changes, from both producer shapes** — a containerised app and a
  `localCommand` one — checked by looking for their records in the store, not by the absence of an
  error. Silence is this change's failure mode: an app whose exporter cannot reach the collector logs
  nothing and reports nothing.
- **Ingest is refused from off-host**: the published binding is loopback, verified against the running
  container rather than against the manifest that asked for it.
- Prod: the query port is loopback and Core no longer proxies telemetry, so an agent on a laptop
  cannot reach a prod backend directly. With the CLI local-only, the motivating case works by running
  `hosty mcp` on the prod host over SSH — worth confirming end to end rather than assumed, since it is
  the case the feature exists for.
