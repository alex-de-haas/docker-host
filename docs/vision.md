# Hosty Platform Vision

Created: 2026-08-19
Updated: 2026-09-26

The umbrella document: where Hosty is going, so individual decisions have a criterion to be judged
against. It authorizes no implementation and owns no deliverables — work it names is tracked in the
owning feature's `plan.md` — and it links the features it spans rather than duplicating them. It is a
living document outside the status workflow: when the direction changes, so does this file, and
`Updated:` says when.

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

## App Creation And Development (owner direction, 2026-09-16)

The intended development loop includes creating apps inside Hosty: an administrator supplies an app
id, display metadata and a prompt, then sees a running prototype beside its assistant session and
iterates in place. An app may begin as a durable local folder without Git. Local does not mean
temporary: source must outlive the conversation, and a valid manifest still gives the app an identity
and version.

Assistant sessions can be associated with any installed app, or several apps, independently of
creation: the operator selects apps in chat or starts a new session from an app's menu. This context
survives panel reloads, and deleting a conversation never removes the ability to start another about
the same app. [Assistant app context](features/assistant-app-context/feature.md) owns that shared work;
context association alone changes neither tool grants nor the development workspace.

App creation is stack-neutral: the starting artifact is minimal metadata with an optional disposable
HTML preview, not a framework template. The agent chooses one or several services and their languages
from the request. Core-owned development guidance describes the platform contract; supported SDKs
simplify integration, while other languages use the same documented API directly.

Owner source-policy decisions, 2026-09-16: new apps use the existing `apps/<id>/source` directory,
including without Git. Reuse existing development/runtime mechanisms wherever they satisfy the
requirements. Core observes source state and warns before operations that could discard work;
Git owns history, and the assistant provides the explicit save/commit/push path. Hosty does not keep
source snapshots or restore history. Ordinary runtime command failures remain Core errors,
restarts are operator/agent-triggered, and new prototype autostart defaults to off.

The same loop extends to source-capable installed apps through declared development profiles and compatible
runtime profiles. Integration with installed apps uses their published interfaces and authorization
contracts. Optional promotion proceeds through repository history, remote source, installable
release/feed and a catalog contribution; the catalog maintainer retains the approval decision.
Those are separate milestones, not one publish flag, and none implies public network exposure.

The [app-authoring epic](features/app-authoring/plan.md) gathers existing mechanisms and assigns the
remaining work to prototype workspaces, development controls, integrations and publication. Its plans
are Draft: this direction does not approve their implementation choices. Interactive live editing
continues decision 2 below. Decision 10 adds session-owned worktrees for Git-backed interactive work;
non-interactive jobs with disposable validation remain the distinct Development Agent Bridge workflow.

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

## Decisions (owner; dates noted below)

Decisions 1–5: 2026-08-19.

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

5. **Hard at the perimeter, sovereign inside, legible between — and the administrator owns the
   install decision.** Three rings, because "security" means a different thing at each distance:
   - **The perimeter is hard and not negotiable.** External clients, the network, anything not on
     this host: authenticated, fail-closed, no functionality argument overrides it. This is the
     protection "извне" — and it is aimed at exactly the era the owner names, where agents find
     holes cheaply.
   - **Inside its own boundary an app is sovereign.** Protection mechanisms must not subtract
     capability; where a guard would block a function, the platform informs the administrator and
     lets them decide. The precedent already shipped: the remote-`localCommand` hard block became an
     amber install warning by owner decision — the dialog says *"Install it only from a source you
     trust — you do so at your own risk"*, which is this principle in one sentence. Do not
     reintroduce hard blocks where a warning does the job.
   - **Between apps, the platform owes attribution and containment — not policing.** "The admin owns
     what they installed" is only a fair model when installing app A grants A's *declared* reach and
     nothing more; one bad install must not silently become fleet-wide reach. This is not caution
     layered on top of the model — it is what makes the model coherent, and it is bought by the
     identity machinery, not by limiting what an app may do in its own ring.
   One boundary survives this decision untouched: **the guards on third-party text steering the
   agent** (draft-only ask-assistant, providers off by default). Those do not protect the system
   from a bad app — they protect the administrator's own agency from being subverted, and consent
   given at install time cannot cover a mechanism that works by deceiving the consenting party.

6. **Session development permissions apply to existing and new apps (2026-09-16).** An administrator
   can explicitly permit source edits and project commands for one or more apps in a session's
   context. Association alone grants nothing. Routine work inside that authorized boundary runs
   without repeated approval cards; filesystem, command and credential restrictions require verified
   enforcement on both harnesses. This changes the former every-write-asks policy within that boundary.
   [Assistant approval rules](features/assistant-approval-rules/plan.md) owns the permissions and the
   experiment required before implementation; app creation consumes the general capability.
   The administrator owns the consequences of code they create and execute through localCommand,
   including malicious code. The current runtime executes under Core's OS account outside the agent
   sandbox; it does not provide filesystem isolation between apps. This qualifies decision 5's
   containment language for localCommand: API identity checks remain, but they do not isolate local
   processes. Explain this at development setup without prompting on every edit or restart.

7. **First development slice prioritizes app boundaries (2026-09-16).** Immediate revocation of
   already-running commands and further experiments on it are deferred tracked work. Permission
   changes apply to subsequent dispatch/resume; existing processes may finish with their original
   rights. Isolation between temporary folders is not a first-slice requirement. Shared scratch
   space is acceptable, while Hosty app source outside granted roots, Core state and credentials
   remain protected. Canonical protected roots under broadly accessible temporary directories need
   an explicit unsupported-placement policy, not an isolation promise. The remaining work and scope
   are owned by [assistant approval rules](features/assistant-approval-rules/plan.md).

8. **Profile-bound development; existing apps first (2026-09-16).** Development is a declared
   `development: true` runtime profile; `dev` is a convention, not a reserved key. Replace the independent
   operator toggle with reviewed profile selection and explicit compatibility handling. Profile commands
   supply hot reload; Core preserves edited source when returning to a reviewed runtime. Prioritize the
   existing-app edit → view/diff → explicit Git discard loop before creation. Development UI identifies
   branch/commit/changes rather than presenting manifest version as the source identity. Ordinary release
   updates and explicit Git synchronization stay separate. Git owns history; no-Git folders have no
   promised undo. Source and development-control plans own implementation; future branch management and
   Docker development are not prerequisites.

9. **App permissions and trusted confirmation (2026-09-18).** Runtime apps declare requested Core
   operations in their manifests; administrator review grants that set. User identity alone does
   not give an app the user's Core authority. Installation permission allows preparing a request;
   the final decision belongs to a Core-owned browser surface, independent of any Shell, and cannot
   be forged with an app token. Custom preparation UI remains supported. Permission increases on
   update cross the same trusted boundary. This adds app grants, not a redesign of user roles or
   external OAuth scopes. [App installation](features/app-installation-sdk/feature.md) describes
   the implementation; its [plan](features/app-installation-sdk/plan.md) owns remaining verification.

10. **Shared development sessions and clients (2026-09-24; clarified 2026-09-26).** A session owns
    a shared conversation and optional registered source workspace. Switching connected agents
    preserves visible context; clients control host-resident work. Keep source diffs and separate
    Publish, Merge and Complete. Prefer managed source with a verified migration from overrides.
    The [session umbrella](features/assistant-development-sessions/plan.md) coordinates independently
    approved feature plans, including rare explicit local external-agent context exchange.

11. **Feedback intake before agent work (2026-09-25).** Users can capture a region or UI element,
    add a comment and submit an app/page-linked observation; screenshots and element context are
    included where available. This covers bugs and improvements. Ordinary users submit without
    agent access. An administrator reviews the inbox, groups related items and explicitly sends
    the selected evidence and a combined request to a session. Administrators may also send their
    own reviewed observation directly. Submission alone starts no agent and grants no source access;
    feedback items are input to sessions, not a second development task model. The capture mechanism,
    narrow user-facing authority, durable evidence and triage UX remain Draft work owned by
    [app feedback inbox](features/app-feedback-inbox/plan.md).

12. **Dedicated native Harness client (2026-09-25).** Build a separate Swift client focused on
    Hosty Harness sessions over AHP, including remote conversation, permission/question requests,
    changed files/diffs and supported session actions. Agents and workspaces remain on the host.
    Phone usability is a primary requirement; compact navigation need not mimic desktop sidebars.
    The existing full Swift Shell remains separate. Generic panels in Swift Shell were considered
    but are not the selected scope, and this decision does not retire that client. The
    [Hosty Harness Swift plan](features/hosty-harness-swift/plan.md) owns native delivery, depends on
    the shared session server contract and remains Draft pending platform/UX/protocol decisions.

13. **AHP as a client interface (2026-09-26, revised after review).** Keep Hosty's existing
    session implementation and journal authoritative. Evaluate AHP as a replaceable external client
    adapter, with a bounded Swift/auth/reconnect spike. Existing web REST/SSE remains; provider
    switching and other internal features do not depend on AHP adoption. Swift targets the official
    SDK subject to the spike. This supersedes the earlier same-day AHP-first foundation/web-cutover
    decision; [client integration](features/assistant-ahp/plan.md) remains Draft.

14. **Authority comes from confirmed declarations, not the system label (2026-09-26).** What an app
    provides is a confirmed role in `provides`; what it may do is a permission in `corePermissions`.
    Keep permissions few, each tied to a real Core check and described in plain language. Required
    roles and permissions are accepted together or the installation is declined; optional
    permissions are offered unchecked and changeable later in the app's settings. `role: system`
    stops conferring privilege and remains an ownership fact. This extends decision 9 with app
    grants and leaves decision 1's admin/user model intact. The
    [core extension model](features/core-extension-model/plan.md) owns the general model;
    [assistant provider permissions](features/assistant-provider-permissions/feature.md) is its first slice.

15. **Core is the MCP directory, not a proxy (2026-09-26).** Agents run on the host; how clients
    reach them is decision 13's AHP spike, and the directory does not depend on it. Core owns which apps' MCP servers agents may use and publishes that
    configuration without credentials; agents configure themselves from it and call each app
    directly, so tool traffic never passes through Core and the agent-bridge boundary stands. A
    single-entry facade for full external clients such as Claude Code or Codex becomes a separate
    app later. [Agent MCP directory](features/agent-mcp-directory/plan.md) owns the directory;
    [MCP facade](features/mcp-facade/plan.md) is On Hold.

## Expectations And Later Directions

- **Apps ship with source.** The default is open source; a company's internal apps are closed by
  their own choice and on their own responsibility. This expectation is load-bearing twice over: the
  develop-in-place story only works on apps whose source is present, and the analysis direction
  below is only meaningful against source.
- **Agent-performed app review.** A future capability, not a design: at install time the harness
  reads the manifest, the declared surfaces, and the source, and reports what the app can reach and
  whether anything looks malicious. The attachment point already exists — the install plan/review
  dialog is where the amber warnings live today. Advisory by definition: a model that misses a
  backdoor does not make the backdoor absent, so this sharpens the administrator's decision and
  never substitutes for the perimeter.
- **The gateway's name (owner follow-up, 2026-09-25).** Rename AI Gateway to **Hosty Harness**
  within the broader [shared development session redesign](features/hosty-harness-rename/plan.md).
  Owner clarification: change the app id too (`hosty.ai-gateway` -> planned `hosty.harness`). The
  operator will uninstall the old app, install the new one and configure it afresh. No old-session,
  settings or credential migration, in-place upgrade or legacy-id aliases are required. Update
  discovery, install/feed references and authorization consistently for the new identity. This is
  an unchecked Draft deliverable, not approval to implement or uninstall the current app now.

## Contribution Points, Named

Today's points exist but were each invented ad hoc: `ui.entrypoint`/`ui.navigation`, then
`ui.settings` and `ui.panel` ([app-ui-surfaces](features/app-ui-surfaces/feature.md)), and `interfaces.mcp`
([app-mcp](features/app-mcp/feature.md)). Widgets are a named future axis.

The direction this document sets: **the next capability does not invent a fifth seam** — it either
fits an existing contribution point or adds one deliberately, as a first-class, documented part of
the manifest contract. Two standing consequences:

- [core-extension-model](features/core-extension-model/plan.md) stops being exploratory the day a platform
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
   [cross-app-dependencies](features/cross-app-dependencies/plan.md)), the user never holds an AI
   credential, and the app's own UI is the boundary deciding which AI functions exist. Decide when
   the first regular-user AI feature ships — [ai-agent-bridge](features/ai-agent-bridge/plan.md) step 10
   is where it will land.
2. **What is the micro-app runtime?** Scale-to-zero, activation on request, cost near zero when
   idle. Shape, isolation, and how it differs from `localCommand` are all open.
3. **What does cross-environment integration look like?** The owner's setup is a local dev
   installation and a separate production host; wanted later: reading prod telemetry from dev and
   reproducing prod errors there. Today's answer is the SSH topology of
   [telemetry-mcp](features/telemetry-mcp/feature.md); anything richer is undesigned.
4. **How are live Core edits seen on a dev environment, with one Core per host and no installation
   split?** No mechanism exists today; running Core from source is the developer loop in this
   repository, not an operator affordance.

## Spanned Features

[hosty-harness-swift](features/hosty-harness-swift/plan.md) ·
[assistant-development-sessions](features/assistant-development-sessions/plan.md) ·
[app-authoring](features/app-authoring/plan.md) ·
[core-extension-model](features/core-extension-model/plan.md) ·
[assistant-provider-permissions](features/assistant-provider-permissions/feature.md) ·
[agent-mcp-directory](features/agent-mcp-directory/plan.md) ·
[ai-agent-bridge](features/ai-agent-bridge/plan.md) ·
[app-ui-surfaces](features/app-ui-surfaces/feature.md) ·
[assistant-entry-points](features/assistant-entry-points/plan.md) ·
[agent-background-sessions](features/agent-background-sessions/feature.md) ·
[runtime-source-workflows](features/runtime-source-workflows/feature.md) ·
[telemetry-mcp](features/telemetry-mcp/feature.md) ·
[hosty-mcp-connector](features/hosty-mcp-connector/feature.md) ·
[cross-app-dependencies](features/cross-app-dependencies/plan.md) ·
[hosty-app-sdk](features/hosty-app-sdk/plan.md)
