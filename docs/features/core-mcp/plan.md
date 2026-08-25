# Core MCP Mutations — Lifecycle Tools With Core-Owned Approval

Status: In Progress
Created: 2026-08-24
Updated: 2026-08-25

[feature.md](feature.md) records why lifecycle mutations were left out of Core MCP: "Core MCP has no
approval mechanism of its own, and the assistant's gate lives in its harness, which pauses only that
harness's own calls. … Shipping one means first deciding where its approval lives." This plan makes
that decision: **the approval lives in Core**, expressed through the scope machinery of
[scoped-access-tokens](../scoped-access-tokens/feature.md), so the gate holds for every caller — the
gateway's harness, an external Claude Code, a bare `curl` — instead of only for calls one harness
chooses to pause. The harness's own approval card remains as in-conversation UX in front of Core's
enforcement, no longer the enforcement itself (the boundary the 2026-08-18 review findings H1/H2
showed to be porous).

**Depends on [scoped-access-tokens](../scoped-access-tokens/feature.md)** for the scopes and the
per-call audit path.

## Target Behavior (diff against feature.md)

- Core MCP gains mutation tools over lifecycle Core already owns — v1 is exactly
  `start_app` / `stop_app` / `restart_app`. Each declares honest annotations: no `readOnlyHint`,
  `destructiveHint` where it applies.
- **Authorization is a standing grant**: the call must carry a credential holding the matching
  mutation scope (vocabulary defined here, e.g. `mcp:lifecycle`). An admin issuing a scoped token
  with that scope — or later consenting to it in the [mcp-oauth](../mcp-oauth/plan.md) consent page —
  *is* the approval, which fits the platform rule that the administrator owns these decisions. A
  call without the scope is refused with the scope named, as a tool result rather than a transport
  error, per feature.md's failure convention.
- Admin-session callers (today's only Core MCP audience) hold full role by definition and pass; the
  scope mechanism exists for the delegated and remote callers that could not be allowed at all
  before.
- Every mutation call is audited with actor, tool, target app, and outcome — refusals included.
- **Per-action approval — a mutation call without a standing grant parking as a pending action that
  an operator approves in Shell or the assistant panel — is deliberately deferred to its own future
  plan.** Standing scopes alone are a shippable, coherent v1: the gate exists, covers every client,
  and defaults closed. Until then, a call without the scope gets the structured refusal naming the
  scope, and nothing pends.

## Deliverables

- [x] Mutation tools on Core MCP with honest annotations, gated on mutation scopes, refusing with
      the scope named.
- [x] Scope vocabulary for lifecycle mutations, recorded as a stable contract next to `mcp:read` —
      including the audience binding (`mcp:lifecycle` pairs only with `hosty:core`) and the rule the
      implementation surfaced: a delegated token never carries lifecycle, because it cannot prove
      the scopes of the credential it descends from.
- [x] Audit lines for every mutation call and refusal.
- [x] feature.md rewritten: the "mutations are absent on purpose" section replaced by the shipped
      authorization model.
- [ ] Live verification through a stock external client: a token with the scope restarts a real
      app; the same client without the scope is refused; both appear in the audit log.

## Resolved Questions (2026-08-24, owner approval in chat)

1. **The v1 verb set is `start_app`/`stop_app`/`restart_app`.** `update_app` is deferred — an
   update can change what an app *is*, which composes poorly with standing grants — and
   install/remove are not exposed over MCP at all in this plan.
2. **The per-action pending-approval flow is deferred to its own future plan**, including the
   headless-client experience (poll a pending id vs MCP elicitation). Until it exists, no scope
   means a structured refusal, never a silent queue.
3. **One `mcp:lifecycle` scope covers all three verbs.** Per-verb scopes wait for a demonstrated
   need.
4. **The gateway's approval card is out of scope and unchanged.** Composing card suppression with
   standing scopes is the gateway's own later policy tweak, not Core's concern.

## Verification

Pair tests: scoped token accepted beside unscoped refused with the scope named; admin session
accepted; audit written for success and refusal; read-only tools untouched by the feature. The
guardrail suite still holds — anonymous callers rejected on every `/api/mcp` route. Live: the
external-client scenario from the deliverables, against a real app on a dev host.
