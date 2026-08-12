# App-Owned MCP

Created: 2026-08-11
Updated: 2026-08-11

Runtime apps expose their domain actions to agents through an MCP endpoint they own, and Core tells
agent clients which apps have one. This is step 4 of the [AI Agent Bridge](../ai-agent-bridge/plan.md)
rollout, and it is the contract [core-mcp](../core-mcp/feature.md) deliberately does not provide:
Core MCP is control-plane only and never proxies work belonging to an app.

## The Division Of Labour

It is the whole point of the contract, and easy to get backwards.

- **Core authenticates.** The caller presents a short-TTL delegated token Core signed; the app
  validates it locally with the public key Core injects as `HOSTY_DELEGATED_TOKEN_PUBLIC_KEY`, so
  Core stays out of the data path and there is no per-call round trip. Apps build no identity system
  of their own — the platform forbids requiring that.
- **The app authorizes.** Core cannot know what a domain action means or who may perform it. Every
  tool re-runs the app's own permission model for the delegated actor, using the same model its HTTP
  routes use rather than a parallel one written for agents. An MCP surface that skipped this would be
  an unauthenticated remote API wearing a protocol.

The audience claim is what stops one app's token working on another, so validation must always pass
the expected app id — the SDK validator defaults it to `HOSTY_APP_ID` and returns null when neither
that nor the key is present, so it fails closed.

## Declaring An Interface

An app declares `interfaces.mcp` in its manifest, pointing at one of its own endpoints and a path:

```json
"interfaces": { "mcp": [{ "key": "default", "endpoint": "api", "path": "/api/mcp" }] }
```

Core normalizes the declaration at install/update and resolves it to a ready-to-call URL from the
app's endpoints, so consumers never assemble origins themselves.

## Discovery

`GET /api/internal/apps/{appId}/app-directory` (app service token) returns the installed roster with
each app's display name, runtime state, and declared interfaces resolved to URLs. It previously
returned id and display name only.

This widens what one app can learn about another, which was a deliberate decision rather than a
side effect: the disclosure is the roster plus where declared interfaces live, and nothing else — no
settings, no secrets, no operational state beyond whether an app is running. Reaching one of those
URLs still requires a Core-issued token the caller does not obtain from this response. The
alternative — a new endpoint gated to system apps — would have added an authorization axis Core does
not otherwise have.

Consumers pull; Core never pushes configuration into an app. The
[ai-gateway](../ai-gateway/feature.md) reads this list to render its MCP provider toggles and owns
which are enabled; Core stays the registry.

## Reference Implementation

`apps/demo-app` serves `/api/mcp` on its backend service:

- JSON-RPC is hand-rolled rather than taken from the MCP SDK, so the Hosty-specific parts — token
  validation, audience checking, and the per-tool permission check — are the visible content of the
  file an app author copies. The read-only surface is three methods (`initialize`, `tools/list`,
  `tools/call`).
- Authentication is checked before the method is dispatched, so an unauthenticated caller learns
  nothing about which tools exist.
- `list_people` requires `demo.people.read` **for the delegated actor**, resolved through the app's
  own role model. A refusal comes back as a tool result carrying `isError: true` — the protocol's own
  failure signal, so a client knows the call failed without parsing the JSON inside the text content
  — while the explanation naming the permission and the role that lacks it stays readable to the
  model. A JSON-RPC error would instead just end the turn.
- `serverInfo` is read from the app's resolved config (`HOSTY_APP_ID` / `HOSTY_APP_VERSION`, injected
  by Core) rather than written as literals: hard-coded identity drifts from the manifest at the next
  version bump, and a reference implementation is copied as-is.
- `get_my_app_role` returns the caller's resolved role, its source, and the permissions it grants —
  the app turning a Hosty identity into its own domain role, which is the step every Hosty-aware app
  has to implement.

## Testing Expectations

- Core: the app-directory response carries `interfaces`, `runtimeState` and `displayName` on every
  entry, present even when empty so a consumer never distinguishes "none" from "field missing"; a
  missing token, a forged bearer, and a token minted for a *different* app are each rejected. That
  last one matters more now that the response describes the whole fleet.
- Gateway: discovery filters to apps declaring `mcp`, prunes toggles for apps Core no longer lists,
  and reports an unreachable Core as `discovery: "unavailable"` rather than as an empty list — an
  unreachable Core and a host where no app declares MCP are different facts, and conflating them
  would quietly tell the operator their apps vanished.
- The same distinction is load-bearing twice more, and both were caught in review after being got
  wrong first:
  - A `200` whose body is not the expected shape counts as a failed read, **not** an empty fleet.
    Otherwise it flows into the prune and permanently deletes every provider toggle the operator set
    — data loss from a version skew. Asserted by a test that goes red without the guard.
  - `list_people` checks the directory snapshot's status before projecting it. An unreachable
    directory returns an `isError` result saying so, because reporting zero people during an outage
    is a false statement about the domain rather than a report about the failure.
- demo-app has no test suite; its MCP route is covered by `tsc`, `eslint` and `next build`, the same
  gates as the rest of that app.
- Not yet done: no MCP client has called the demo-app endpoint. The contract is exercised by Core's
  and the gateway's suites up to the point of the call itself.
