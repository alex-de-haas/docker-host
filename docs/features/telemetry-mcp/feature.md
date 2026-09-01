# Telemetry Over MCP

Created: 2026-08-17
Updated: 2026-09-01

The fleet's **stored** telemetry — searchable logs, traces, and resource metrics — is an MCP
interface an agent can call, behind a credential the query API did not have before this shipped.

It closes a gap Core MCP states in its own tool description: `tail_app_logs` is *"a live tail, not a
searchable log store — ask for more lines rather than expecting to filter"*. This is the other half.

## Reading Is Authenticated

Every route under `/api` on the telemetry backend requires a token Core signed. Before this, the query
API carried none at all, which is why nothing could be built on top of it: the
[app-MCP](../app-mcp/feature.md) contract is "Core authenticates, the app authorizes", and an app with
no authentication cannot honour it.

Two shapes of caller, one verification key:

| Caller | Presents | Checked |
| --- | --- | --- |
| An app (the telemetry UI) | `hosty_app_identity`, minted at start | signature, **and that it names this very app** |
| A user, through MCP | `hosty_delegated`, short-TTL | signature, audience is this app, not expired |

**An app identity is only ever this app's own.** Core injects one into every app, so "correctly
signed" is nowhere near sufficient: accepting any would let any installed app read the whole fleet's
telemetry with no administrator anywhere in the story. The legitimate app caller is the telemetry UI,
and it is a sibling *service* of this same app — Core mints identity per app — so its token names this
app id. Everything else goes down the delegated path, where a user and a role are checked.

The key is the **public half of Core's existing delegated-token pair**, which Core already injected
into every app as `HOSTY_DELEGATED_TOKEN_PUBLIC_KEY`. Verification is local: Core is not in the read
path, so a query costs no round trip and keeps working while Core restarts.

**The gate is a group filter, not a per-route check.** A route added later is closed by default —
the failure mode of the per-route style is the endpoint someone forgets. `/healthz` is deliberately
outside it: a health check that needed a credential would make an unauthenticated backend look *dead*
rather than *closed*, and Core polls it to decide whether the app is up.

**An unconfigured backend refuses everything.** If Core injected no key, every read is refused with a
message saying so. Falling through to "allow" would have made the whole feature a no-op on exactly
the deployments where the key failed to arrive, and looked identical to working.

## The App Identity Credential

`AppIdentityTokenService` mints `hosty_app_identity.1.<payload>.<signature>` for an app at start,
injected as `HOSTY_APP_IDENTITY_TOKEN` by both runtime adapters.

**Why a new credential rather than the existing one.** `AppServiceTokenService` already proves app
identity, but its key is an **HMAC** — only Core can check it, and handing that key to a verifying app
would let that app mint a token for any other, destroying the attribution the credential exists to
provide.

**Why no new key pair.** It signs with `DelegatedTokenSigningKey`, which is already ECDSA, already
durable, and whose public half is already distributed. Cross-type replay is impossible because the
prefix and version are part of the signed input: swap `hosty_delegated` for `hosty_app_identity` and
the signature no longer covers the string being verified. Both directions are tested.

**No expiry, deliberately.** The token lives exactly as long as the process it was injected into — the
same shape and trust level as the service token beside it. A TTL without a refresh path would buy a
bounded leak at the price of telemetry that silently stops after N days on a long-running host: one is
a risk, the other is a certainty.

**Administrator-only reads are inherited, not re-implemented.** `apps/telemetry` is `role: system`, so
Core refuses to mint a delegated token for it to anyone who is not a host administrator. A second copy
of that rule here is the copy that would go stale.

## The Tools

`interfaces.mcp` points at `/api/mcp` on the backend's query endpoint. Four tools, all declaring
`readOnlyHint: true` — without it the connector's fail-closed filter would export nothing at all.

- **`search_logs`** — time range, minimum severity, app set, substring.
- **`list_traces`** — recent traces, newest first.
- **`get_trace`** — every span of one trace, merged across the apps that took part.
- **`get_metrics`** — one app's series, summarised over the window.

## Metrics Answer "How Loaded", Not "What Happened"

`get_metrics` exists because the other three answer questions about events, and an agent asked about
CPU or memory pressure had nothing to call — the data was already stored and already drawn in the
telemetry UI, reachable over HTTP at `/api/apps/{appId}/metrics`, but no tool exposed it. It is
app-scoped for the same reason that endpoint is: metrics are stored per app.

Each series comes back **summarised** — `latest`, `min`, `max`, `average`, the sample count, and the
first and last timestamps — rather than as raw points. An hour of a few dozen series is thousands of
samples, and the question is answered by the shape.

Three things about the store would otherwise be misread, so the tool states them:

- **Absence is never zero.** `container.cpu.percent`, `container.memory.bytes` and
  `container.memory.percent` come from `docker stats`, so an app running under `localCommand` has no
  container and produces none of them. An empty list left to interpret invites "this app uses no
  CPU"; a result carrying none of those three gets a `note` saying which kind of nothing it is. The
  three names are matched exactly, not by a `container.` prefix — an app may export its own meter
  under that namespace, and accepting it as evidence would suppress the note. The note also fires
  when a *filtered* read asked for CPU and got only the app's own meters back: answering half the
  question in silence is the same misreading, arrived at differently.
- **A low sample count means steady, not broken.** Ingest drops unchanged values and re-records a
  flat series only once a minute, so five points over five minutes is a quiet series, not a failing
  collector.
- **The series list is capped**, at 100 by default and 500 at most. Unlike the log and trace stores,
  this query returns everything in range, so one app with high-cardinality labels would otherwise
  hand the client megabytes. Because the cap is applied here rather than in the store, `truncated` is
  exact instead of the "a full page may mean more" the other tools report. Docker stats sort ahead of
  everything else so the cap can never be what hides CPU and memory — a truncated result that
  honestly reported truncation would still have read as "no container metrics".

A failed call comes back as a normal result carrying `isError`, the protocol's own signal, so the
model can read why and choose something else; an unimplemented *method* is a JSON-RPC error, because
that is a protocol fault rather than a tool that failed. Conflating the two would teach a client the
wrong recovery.

## Every Result Says What Produced It

The store clamps range and row count. A burst has already hidden real data behind exactly that: an app
logging ~2k/h looked quiet through a 1-hour, newest-500 view. So every result carries a `window`:

```json
{ "rangeSeconds": 3600, "rangeClamped": true, "limit": 2000, "limitClamped": true,
  "returned": 2000, "truncated": true }
```

An agent that cannot see the clamp reports "no errors" when it means "none in the newest 500" — a
false statement about the host rather than a report about the query. `truncated` is derived from a
full page, and is deliberately "there may be more" rather than a count: the store gives no other
signal, and overstating it would send an agent hunting for data that is not there.

Two ways this contract can lie about itself, both closed and both tested. The reported default has to
be the one the store actually uses — it was 100 against a real default of 50, so a full page of 50
announced itself as unclamped. And clamping is "the value that ran is not the value asked for", which
catches the low end too: the schemas publish no minimum, so `range_seconds: 0` is a plausible input
the store raises to 1, and calling that honoured is the same lie at the other end.

## What This Does Not Do

**Ingest is unchanged and remains open.** Any process that can reach the collector's OTLP port may
write spans attributed to any `hosty.app.id`, and that port is published on `0.0.0.0`. Confining it is
[cross-app-dependencies](../cross-app-dependencies/plan.md)'s, handed over because it needs the shared
network that feature is building and nothing less.

The reason is worth keeping, because the obvious fix is wrong: the port is **not** exposed for
frontend apps — nothing in Hosty emits OTLP from a browser, since the `OTEL_*` variables Core injects
are server-side. It is exposed so **containers** can reach the collector, whose `host.docker.internal`
is a bridge-gateway address that cannot reach a loopback bind. Removing the exposure on its own would
silently stop ingest from every containerised app.

Reads being authenticated does not narrow this, and this document does not imply it does.

## Reaching It From Another Machine

The query port is loopback and Core no longer proxies telemetry, so an agent on a laptop cannot reach
a remote backend directly. With the CLI local-only, the path is `hosty mcp` on that host over SSH —
the connector then exports these tools like any other app's.

## Testing Expectations

- **Auth, as pairs.** Every refusal is asserted beside an acceptance, since a gate that refuses
  everything satisfies each negative alone: an app identity accepted and named; a delegated token
  accepted for this audience and refused for another; an expired one refused and a live one accepted;
  a token signed by another key refused beside the genuine one; **another app's identity refused
  beside this app's own, though Core signed both**; malformed headers refused beside a good one; and
  the unconfigured backend refusing rather than allowing.
- **Cross-type replay** in both directions — a delegated token relabelled as an app identity, and the
  Core-side twin of that check.
- **The truncation contract in every direction.** A full page reports `truncated`, a partial page does
  not; an over-large request reports `rangeClamped`/`limitClamped`, an ordinary one reports neither,
  and a request *below* the minimum reports them too. A flag that is always true says nothing. The
  reported trace default is asserted against the store's own, since a mismatch there hides truncation
  inside the very contract that exists to reveal it.
- **Tool metadata**: every tool declares `readOnlyHint`, the names are the four above, and
  `search_logs` says when to prefer it over a console tail — the model has to be able to tell this
  interface from Core's.
- **Metrics summarise and explain their own emptiness.** A recorded series is asserted through its
  aggregates; a store with nothing in it says so rather than returning a bare empty list; an app with
  only its own meters is told why there is no `container.*` series, **beside** a containerised app
  that correctly gets no such note; and a name filter that matches nothing says "no series matched"
  instead of blaming the runtime, while a filter naming CPU alongside an app meter still gets the
  note. The cap is asserted in both directions — a capped result reports `truncated`, a whole one
  does not — and paired with the case that matters most: docker stats survive a cap tight enough to
  drop twenty other series.
- **Not yet verified live.** No agent has called these tools against a running host, and the telemetry
  UI has not been loaded against the authenticated backend. `get_metrics` adds a third: no reading has
  been taken from real `docker stats` data, so the three metric names are asserted only against
  Core's own constants in `DockerStatsExposition`, which this app copies because it cannot reference
  Core. All three are ordinary checks that need a host running this version.
