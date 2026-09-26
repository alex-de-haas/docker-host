# Assistant Provider Permissions

Created: 2026-09-26
Updated: 2026-09-26

## Confirmed Roles And Permissions

An app requests the assistant role with `provides: ["assistant"]` and locates its API with the
`ai-gateway` interface. Core records administrator-confirmed roles in `ConfirmedRoles` and exposes
`confirmedRoles` in app summaries. Interface declarations, app IDs and `role: system` grant no
assistant role. Other provisioning slots, including `otlp-collector`, retain their existing behavior.
The assistant role supports multiple providers with no Core default.

`apps.skills.read` permits cross-app reads through `/api/internal/apps/{caller}/agent-skills/{target}`.
The endpoint checks the persisted `GrantedCorePermissions` on every request. Neither an assistant
role nor an interface is a substitute for that permission. A grant can belong to a non-assistant app.

Install review shows the requested roles and permissions with Core-provided descriptions. Core's
confirmation page also marks update additions and removals. Queued updates adding either require
Core confirmation; trusted local control operations retain their existing operator authority.
Confirmed grants are recorded from the reviewed selection. Source adoption, restart and projection
backfill preserve the confirmed set without inferring new grants. Reviewed removal revokes the
corresponding role or skill access. Existing records with no confirmed roles remain unconfirmed.

## Shell Selection And Routing

Every confirmed app declaring `ai-gateway` has one assistant panel tab. Its first declared panel is
used, or its UI entrypoint when it has no panel. A stopped assistant retains an unavailable tab.
Shell's administrator entry points use the **Settings → Shell → Assistant for Shell** preference,
stored as a per-user, per-Core cookie in Shell. Direct conversation in a panel belongs to that app.

A single assistant is implicit only before any explicit choice. Multiple assistants trigger a chooser.
An invalid stored choice remains stored and forces another choice even when only one assistant is
left. A stopped selected assistant reports unavailable rather than falling back. Cancelling the
chooser sends nothing. Pending choices are cancelled when the acting user changes.

Embedded workspace, settings and panel frames of eligible assistants receive only their own
audience-bound delegated tokens through the existing source-window/origin-validated handshake.
Outbound drafts and session handoffs retain the selected app and acting user, so changing the
preference cannot send an existing draft to another assistant or another signed-in user.
Gateway notification links include `assistantApp` as well as `assistantSession`; Shell resolves the
owner independently of the preference. An older ownerless link resolves only on a single-assistant host.

## Transition And Boundaries

Core/CLI 0.108.0 introduces the role and permission. Shell 0.83.0 consumes confirmed roles;
SDK 0.15.0 renders their descriptions; Gateway 0.32.3 requests the role and skill permission.
Update Core first, then confirm the Gateway update. Until confirmation, the older installation has
no assistant tab and no cross-app skill access. No app-ID-based grants or grant migration run.
An older Core rejects the new unknown permission. The Harness rename uses the same declarations.

The gateway MCP facade and its OAuth resource resolution are unchanged. The delegated-token
exchange and on-behalf-of route still require `role: system`: a confirmed non-system assistant can
read skills and appear in Shell, but cannot exchange tokens to call another app. General delegation
permissions belong to the [core extension model](../core-extension-model/plan.md).

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
