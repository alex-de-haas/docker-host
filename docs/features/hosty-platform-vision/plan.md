# Hosty Platform Vision

Status: Draft
Created: 2026-08-19
Updated: 2026-08-19

The umbrella document: where Hosty is going, so individual decisions have a criterion to be judged
against. It authorizes no implementation, owns almost no deliverables, and links the features it
spans rather than duplicating them.

## Thesis

Hosty is becoming a **tightly integrated pair of a hosting platform and an agent harness — where
hosting is what produces the harness's tool environment.** Installing an app is not adjacent to the
agent story; it *is* the agent story: an installed app brings its MCP tools, its telemetry, its
surfaces, and its identity, and the agent's reach grows by exactly that much.

This is not a hybrid of two products. The seam is already built, and every mechanism on it serves
both halves at once:

| Mechanism | Hosting half | Harness half |
| --- | --- | --- |
| Delegated tokens | app authenticates its user | the agent's per-call credential to app tools |
| `interfaces.mcp` | an app's self-description | the tool set of the assistant and of external clients |
| App identity | app→app authorization | how telemetry answers the agent |
| Telemetry | fleet observability | the agent's diagnostic tools |
| The manifest | what to run and how | which surfaces and tools appear |

The intended operator story: a small company hosts its working software on Hosty; an administrator
or a small team develops those apps *in* Hosty — edit, run, and test in place — and agents do an
increasing share of that work under the operator's control. Regular users work in the apps; their
feedback reaches development through surfaces built for it (an annotation overlay is the recorded
example), with the administrator approving what becomes an agent's task.

## The Security Consequence

If installing an app extends the agent, then **installing an app is a capability grant**, and the
rules this repository already enforces stop being caution and become the product's core security
property:

- MCP providers are off by default; enabling one is a decision, not a side effect of installing.
- An app's `readOnlyHint` is an assertion, not enforcement; whose word counts is the operator's
  per-app choice.
- Third-party text never becomes agent behaviour without a human between them: an app can fill the
  assistant's draft, only the operator sends.
- External clients stay read-only until enforcement is real rather than labelled.

Any future feature that weakens one of these must say so in its plan, in those words.

## Decisions (owner, 2026-08-19)

1. **Scopes are deferred; admin/user is the model until user-rights separation is actually needed.**
   Regular users get no administrative rights and no direct agent access — no free-text prompting.
   AI reaches them only through functions an app builds on top of it (the recorded example: a
   "generate checklist from this task" button in project-manager). The one place this bites is
   recorded as open question 1 below, and it is a *gate*, not a blocker: nothing needs deciding
   until the first such feature ships.
2. **Dev mode is the live-edit mechanism, and the update flow stays as it is.** An administrator
   flips an app to dev mode, edits through the agent, sees the change immediately; when done, the
   change goes back through PR → review → merge → update. Backups bound the data risk. Separate
   dev and production *installations* are the operator's own practice (and the owner's actual
   setup), not a platform-level split — what the platform owes is the mechanism of editing in the
   executing environment with immediate feedback.
3. **One Core per host, always.** A second Core adopting the live host's containers is a failure
   mode this project has already paid for, not a topology. Seeing live Core edits on a dev
   environment is wanted — without splitting environments into distinct installations — and is open
   question 4; no mechanism for it exists today.
4. **The extension model stays out-of-process, and contribution points grow as features need
   them.** Apps are the extension mechanism; the isolation, identity and credentials they already
   have are the point. In-process plugin composition (the Cordis / "everything is a plugin in one
   runtime" style) is explicitly rejected — Hosty's boundary is a protocol, not a shared object
   graph. What VS Code is the better reference for is *enumerable contribution points*: declared in
   a manifest, rendered natively by Shell when declarative, served by the app when rich. A future
   runtime kind for **micro apps that consume nothing until a request arrives** is the expected
   answer to "ten small extensions must not cost ten containers" — a direction, not a design.

## Contribution Points, Named

Today's points exist but were each invented ad hoc: `ui.entrypoint`/`ui.navigation`, then
`ui.settings` and `ui.panel` ([app-ui-surfaces](../app-ui-surfaces/plan.md)), and `interfaces.mcp`
([app-mcp](../app-mcp/feature.md)). Widgets are a named future axis.

The direction this document sets: **the next capability does not invent a fifth seam** — it either
fits an existing contribution point or adds one deliberately, as a first-class, documented part of
the manifest contract. Two standing consequences:

- [core-extension-model](../core-extension-model/plan.md) stops being exploratory the day a platform
  capability ships as a swappable app through a *named* contribution point rather than a bespoke
  integration. That is its graduation criterion.
- The manifest is becoming an API in the `vscode.d.ts` sense. The "never bump `schemaVersion` for
  ordinary changes" discipline holds while additions stay additive; the day a contribution point
  needs breaking change, the contract needs a real versioning conversation first.

## Open Questions

1. **How is a regular user's app-mediated AI call authorized?** The gateway is a system app, so Core
   refuses to mint a delegated token for it to a non-admin (`system_app_admin_required`) — a
   *user-attributed* credential path is closed by design. The direction that fits decision 1: the
   app calls the gateway **as the app** (the app-to-app story of
   [cross-app-dependencies](../cross-app-dependencies/plan.md)), the user never holds an AI
   credential, and the app's own UI is the boundary deciding which AI functions exist. Decide when
   the first regular-user AI feature ships — [ai-agent-bridge](../ai-agent-bridge/plan.md) step 10
   is where it will land.
2. **What is the micro-app runtime?** Scale-to-zero, activation on request, cost near zero when
   idle. Shape, isolation, and how it differs from `localCommand` are all open.
3. **What does cross-environment integration look like?** The owner's setup is a local dev
   installation and a separate production host; wanted later: reading prod telemetry from dev and
   reproducing prod errors there. Today's answer is the SSH topology of
   [telemetry-mcp](../telemetry-mcp/feature.md); anything richer is undesigned.
4. **How are live Core edits seen on a dev environment, with one Core per host and no installation
   split?** No mechanism exists today; running Core from source is the developer loop in this
   repository, not an operator affordance.

## Deliverables

- [x] `docs/root.md`'s prose overview names the direction and links here (this PR).
- [ ] [core-extension-model](../core-extension-model/plan.md) records its graduation criterion with
      a link here, retiring "exploratory" by decision rather than by drift.
- [ ] Open question 1 is answered in a plan before the first regular-user AI feature ships.

Version outcome: documentation-only, here and for every change this umbrella ever makes itself.

## Spanned Features

[core-extension-model](../core-extension-model/plan.md) ·
[ai-agent-bridge](../ai-agent-bridge/plan.md) ·
[app-ui-surfaces](../app-ui-surfaces/plan.md) ·
[assistant-entry-points](../assistant-entry-points/plan.md) ·
[agent-background-sessions](../agent-background-sessions/plan.md) ·
[runtime-source-workflows](../runtime-source-workflows/feature.md) ·
[telemetry-mcp](../telemetry-mcp/feature.md) ·
[hosty-mcp-connector](../hosty-mcp-connector/feature.md) ·
[cross-app-dependencies](../cross-app-dependencies/plan.md) ·
[hosty-app-sdk](../hosty-app-sdk/plan.md)
