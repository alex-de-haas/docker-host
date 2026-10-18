---
created: 2026-09-26
updated: 2026-10-10
summary: Apps request the assistant role with provides, and Core records administrator-confirmed roles.
components: [apps/core, apps/shell, apps/harness]
---

# Assistant Provider Permissions

## Confirmed Roles And Permissions

An app requests the assistant role with `provides: ["assistant"]` and locates its API with the
`assistant` interface. Core records administrator-confirmed roles in `ConfirmedRoles` and exposes
`confirmedRoles` in app summaries. Interface declarations, app IDs and `role: system` grant no
assistant role. Other provisioning slots, including `otlp-collector`, retain their existing behavior.
The assistant role supports multiple providers with no Core default.

`apps.skills.read` permits cross-app reads through `/api/internal/apps/{caller}/agent-skills/{target}`.
The endpoint checks the persisted `GrantedCorePermissions` on every request. Neither an assistant
role nor an interface is a substitute for that permission. A grant can belong to a non-assistant app.

`apps.workspaces.manage` permits session-owned source workspaces and local Git operations, with an
app service token plus a current administrator credential addressed to that app. It is independently
reviewed and checked on every request. See [session workspaces](../assistant-session-workspaces/feature.md).

Install review shows the requested roles and permissions with Core-provided descriptions. Core's
confirmation page also marks update additions and removals. Queued updates adding either require
Core confirmation; trusted local control operations retain their existing operator authority.
Confirmed grants are recorded from the reviewed selection. Source adoption, restart and projection
backfill preserve the confirmed set without inferring new grants. Reviewed removal revokes the
corresponding role or skill access. Existing records with no confirmed roles remain unconfirmed.

## Shell Selection And Routing

Shell’s shared workspace lists accessible declared panels, including multiple panels from one
assistant app. A stopped panel retains an unavailable tool entry. Navigation-only assistant
handoffs retain their explicit separate-open destination.
Shell's administrator entry points use the **Settings → Shell → Assistant for Shell** preference,
stored as a per-user, per-Core cookie in Shell. Direct conversation in a panel belongs to that app.

A single assistant is implicit only before any explicit choice. Multiple assistants trigger a chooser.
An invalid stored choice remains stored and forces another choice even when only one assistant is
left. A stopped selected assistant reports unavailable rather than falling back. Cancelling the
chooser sends nothing. Pending choices are cancelled when the acting user changes.

Embedded frames authenticate directly with Core; Shell’s shared SDK frames install no delegated-token
responder. Core enforces app assignment and system-app access for app-owned authentication. Shell-owned shortcuts remain admin-only.
Outbound session commands retain the actor and resolved app/installation/panel/route, so they reach
only the intended frame. Harness notification links include `assistantApp`, `assistantPanel` and
`assistantSession`; Shell resolves the owner independently of the preference. An older ownerless
link resolves only on a single-assistant host, and a link without a panel ID resolves only when
that app declares one panel. Ambiguous or unavailable destinations remain pending.

## Transition And Boundaries

Core/CLI 0.108.0 introduces the role and permission. Shell 0.83.0 consumes confirmed roles;
SDK 0.15.0 renders their descriptions; Gateway 0.33.0 requests the role and skill permission.
Update Core first, then confirm the Gateway update. Until confirmation, the older installation has
no assistant tab and no cross-app skill access. No app-ID-based grants or grant migration run.
An older Core rejects the new unknown permission. The Harness rename uses the same declarations.

The gateway MCP facade retains a system-gated on-behalf-of route. The legacy exchange route
rejects cross-app exchange. Assistant MCP access uses Core-owned per-assistant target grants and
a separate MCP credential, including for confirmed non-system assistants; see
[assistant MCP access](../agent-mcp-directory/feature.md). Remaining general delegation is tracked
in [cross-app auth](../cross-app-auth/plan.md).

## Testing Expectations

- Exercise install confirmation against source changes between review and apply; confirm only the
  displayed selection, with human-readable descriptions and update additions/removals.
- Verify role-only and role-plus-permission updates require confirmation, survive Core restart and
  revoke on removal; source projection/backfill grants neither automatically.
- Pair permitted skill reads with denied interface-only/system-only reads and revoke a grant while
  reusing the same service token. Verify non-system assistant delegation remains forbidden.
- Verify two assistants, stopped providers, choice persistence, stale choices, cancellation and user
  changes. Check per-frame token audience and app-bound drafts/session links.
- Build Core, Shell and SDK; run Core HTTP/lifecycle tests, Shell logic/component tests, SDK and
  Gateway tests. Check the Core-managed app transition and embedded assistant experience.
