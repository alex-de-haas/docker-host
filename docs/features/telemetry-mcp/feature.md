# Telemetry Over MCP

Created: 2026-08-17
Updated: 2026-08-17

The fleet's **stored** telemetry — searchable logs and traces — is an MCP interface an agent can call,
behind a credential the query API did not have before this shipped.

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
| An app (the telemetry UI) | `hosty_app_identity`, minted at start | signature, and which app it names |
| A user, through MCP | `hosty_delegated`, short-TTL | signature, audience is this app, not expired |

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

`interfaces.mcp` points at `/api/mcp` on the backend's query endpoint. Three tools, all declaring
`readOnlyHint: true` — without it the connector's fail-closed filter would export nothing at all.

- **`search_logs`** — time range, minimum severity, app set, substring.
- **`list_traces`** — recent traces, newest first.
- **`get_trace`** — every span of one trace, merged across the apps that took part.

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
  a token signed by another key refused beside the genuine one; malformed headers refused beside a
  good one; and the unconfigured backend refusing rather than allowing.
- **Cross-type replay** in both directions — a delegated token relabelled as an app identity, and the
  Core-side twin of that check.
- **The truncation contract in both directions.** A full page reports `truncated`, a partial page does
  not, and an over-large request reports `rangeClamped`/`limitClamped` while an ordinary one reports
  neither. A flag that is always true says nothing.
- **Tool metadata**: every tool declares `readOnlyHint`, the names are the three above, and
  `search_logs` says when to prefer it over a console tail — the model has to be able to tell this
  interface from Core's.
- **Not yet verified live.** No agent has called these tools against a running host, and the telemetry
  UI has not been loaded against the authenticated backend. Both are ordinary checks that need a host
  running this version.
