# MCP Facade — One Remote Endpoint For The Whole Fleet

Status: In Progress
Created: 2026-08-24
Updated: 2026-08-25

An aggregating streamable-HTTP MCP server on the `hosty.ai-gateway` system app: one config entry in
an external client (Claude Code, VS Code, Cursor, a phone client) yields Core's control-plane tools,
every app's MCP tools, and app skills — over HTTPS, with no CLI or SSH on the path. This resolves
[ai-agent-bridge](../ai-agent-bridge/plan.md) step-7 topology 4, which recorded the need as "a
remote HTTP MCP endpoint with OAuth, a future `mcp-hub` system app … Core never hosts it": the
mcp-hub is the existing gateway system app, and Core still hosts nothing.

**Depends on [scoped-access-tokens](../scoped-access-tokens/feature.md).** Without it the facade has no
credential an external client could present, and building an ad-hoc gateway key would be discarded
the day scoped tokens land.

## Target Behavior

- **A full MCP server, not a catalog route.** `initialize`, `tools/list`, `tools/call`, and
  `notifications/tools/list_changed` on fleet changes — an installed app's tools appear in a
  connected client without touching its config, which retires the static-config staleness problem
  for good. A bare listing endpoint would be useless: a client could see the tools and still not
  call them.
- **Built from parts the gateway already has**: provider discovery
  ([providers.ts](../../../apps/ai-gateway/src/settings/providers.ts)), the delegated-token exchange,
  the transparent forwarder ([proxy.ts](../../../apps/ai-gateway/src/mcp/proxy.ts)), and the
  fail-closed read-only filter ([readonly.ts](../../../apps/ai-gateway/src/mcp/readonly.ts)). New
  work is the MCP server shell around them plus external authentication.
- **Authentication**: a bearer scoped access token with the facade as its audience, introspected
  against Core per request — the same contract every app uses, so the facade adds no second auth
  mechanism.
- **On-behalf-of, with attribution**: for each `tools/call` the gateway obtains a delegated token
  for the *introspected user* and the target app, so the app authorizes the real actor and audit
  lands on the user, never on the gateway.
- **Core's tools are in the catalog** so one entry truly covers the host. The on-behalf-of
  credential mirrors the app path: Core's existing delegated-token exchange gains Core MCP as a
  target, so the gateway exchanges its service token plus the introspected user for a short-lived
  Core MCP credential per call — same machinery, same audit, no new trust axis. Direct connection
  to Core `/api/mcp` remains supported regardless: the gateway is a removable system app, and a
  host without it must not lose agent access to Core. The facade is convenience, not a monopoly.
- **Tool naming reuses the connector's scheme** (`<key>__<tool>`, reversible id escaping, length
  hashing) for the same reasons it was designed that way — stable names an unrelated install cannot
  shift, safe `__` boundaries — and so the two surfaces never teach clients two dialects.
- **Visibility follows Core's policy**, exactly as in the connector: an app the acting user may not
  reach drops out when Core refuses to mint its token — the facade re-implements no access rules.
- **Read-only, fail-closed**, until mutation scopes exist ([core-mcp](../core-mcp/plan.md)): only
  tools declaring `annotations.readOnlyHint: true` are exported, hidden from the list *and* refused
  on call, enforced facade-side.
- **Skills ride `initialize` `instructions`**, as the connector already does: only apps whose tools
  the client actually received contribute; only operator-approved texts (the gateway's existing
  digest-approval store) are delivered — appropriate here because facade callers are remote users,
  not the operator the connector's ungated path assumes; the facade's own text comes first and
  unwrapped (the attribution contract of
  [app-provided-skills](../app-provided-skills/feature.md)). The protocol has no
  instructions-changed notification, so an updated skill reaches a client on reconnect — accepted.
- **Perimeter**: exposed through the app's public-origin machinery, rate-limited, and the facade
  never logs a bearer.

## Deliverables

- [x] MCP endpoint on the gateway, authenticated by scoped-token introspection.
- [x] Aggregated `tools/list` with connector-compatible naming.
- [x] Per-call forwarding through per-user delegated tokens, read-only filter enforced.
- [x] Core MCP tools in the catalog. The exchange could not serve this — it branches off a token
      descended from a browser interaction — so Core gained an on-behalf-of route instead, and
      `hosty:core` as a delegation target; recorded in [feature.md](feature.md).
- [x] Skills delivered via `instructions`, approval-gated, attribution order asserted.
- [x] The rate-limited perimeter this plan's Target Behavior called for. It was implemented without being listed here, which is how a stated obligation goes untracked — recorded now, and described in [feature.md](feature.md).
- [ ] `notifications/tools/list_changed` on fleet changes. Needs the streamable-HTTP GET stream,
      which the endpoint currently refuses rather than half-implements; until it exists, a client
      sees a newly installed app's tools on its next connection.
- [ ] Live verification from a stock Claude Code over a **non-loopback** origin — which also closes
      the last open cell of ai-agent-bridge step 6, and is recorded there when it happens. The
      loopback half was proven on 2026-08-25 (recorded in [feature.md](feature.md)): one config
      entry, aggregated catalog, on-behalf-of forwarding, read-only filter and revocation all
      exercised by a stock `claude -p` on the dev host — but that host runs no ingress, so external
      origin, TLS and a proxy in the path remain unexercised.
- [ ] On ship: ai-agent-bridge topology-4 note and decision log updated to name the facade.

## Resolved Questions (2026-08-24, owner approval in chat)

1. **On-behalf-of for Core MCP**: the delegated-token exchange grows Core MCP as a target,
   mirroring the app path — folded into the design and deliverables above.
2. **`hosty mcp` is unchanged by this feature.** It stays the answer for hosts without the gateway
   and for SSH-only setups; any convergence (thin client of the facade, exporting Core's tools) is
   its own future plan.
3. **Generic-surface degradation is deferred** until a real fleet approaches the connector's
   ~60–80-tool threshold; the facade ships namespaced export only.
4. **Sessions are ephemeral**: a gateway restart drops them and clients re-initialize; nothing about
   facade MCP sessions persists the way harness sessions do.

## Verification

A stock client with a single facade entry lists tools from Core and at least two apps, calls one
read-only tool per source, sees a newly installed app's tools arrive via `list_changed`, is refused
on a non-read-only tool, and receives approved skills in `instructions` with the facade's text
first. A second user's token shows a smaller catalog matching their app access. All of it against a
non-loopback origin.
