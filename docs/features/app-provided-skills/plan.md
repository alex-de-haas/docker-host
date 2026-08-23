# App-Provided Skills

Status: In Progress
Created: 2026-08-20
Updated: 2026-08-20

An app ships the prose an agent needs to use it well, the way it already ships its icon and its
long description — and an operator decides, per app, whether that prose reaches a model.

## Goal

MCP tells an agent *what calls exist*. It does not tell it *how this app is meant to be worked*:
which tool to reach for first, what the app's domain words mean, what a call is expensive to repeat,
what a refusal means. Today that knowledge lives in the app's README, where no agent will look.

One skill already exists at the platform level —
[`packages/hosty-claude-plugin/skills/hosty-mcp-connector`](../hosty-mcp-connector/feature.md) —
explaining the *connector*: tool naming, the id escaping, why a tool is absent. It is deliberately
about Hosty, not about any app, and it cannot grow to cover apps Hosty does not know.

## Current Behavior

- Apps declare `interfaces.mcp`; Core resolves it to a URL and `hosty mcp` exports the read-only
  tools ([app-mcp](../app-mcp/feature.md)).
- Apps already own display assets in their own repository: `metadata.icon`, `metadata.screenshots`
  and `metadata.descriptionFile` (a markdown path). Core **vendors** them — copying into the app root
  under a byte budget, with path containment and, for markdown, resolution of the images it
  references — and serves them from `/api/apps/{id}/assets/{path}?v=<version>`. That comment calls
  them "display-only, outside runtime validation", which is exactly the property that stops being
  true here.
- MCP providers are per-app and arrive **switched off**, because a tool's name and description are
  text the app wrote landing in the context of a model with shell access on the host. The settings
  page says so in those words.
- Nothing an app writes reaches an agent as *instructions*. Claude-based harnesses read skills from
  the operator's own machine (`settingSources: ["user", "project"]`); Codex has no skill mechanism at
  all.

## Target Behavior

- **An app may declare one skill**, as a manifest-relative markdown path, carried and served by the
  existing asset mechanism. The app repository owns the file; Core neither authors nor edits it.
- **It reaches a model only when the operator says so, per app, off by default.** This is not new
  policy: it is the rule MCP providers already follow, applied to something strictly larger. A tool
  description is a line of app-authored text in the model's context; a skill is a document of it.
  Installing an app must not be a way to write into an agent's context.
- **Harnesses differ honestly.** Skills are a Claude Code mechanism. A Codex session gets nothing
  from this and must be told so — the same shape as `capabilities.appMcp`, which was reported false
  for a year rather than silently doing nothing.
- **The skill is about procedure, not inventory.** Restating tool descriptions duplicates what MCP
  already carries and goes stale separately. What earns its place: order of operations, domain
  vocabulary, which tool to prefer, what a refusal means.
- Delivery to a client is out of scope for the first phase: the file being declared, vendored,
  gated and readable is what everything else builds on.

## Deliverables

- [x] Manifest: an optional skill declaration, validated like the other asset paths (relative,
      contained, `.md`, size-capped) and **rejected when it names anything outside the manifest
      folder**.
- [x] Core: vendoring and serving through the existing asset endpoint, reusing the byte budget rather
      than adding a second one.
- [x] Gateway: an enabled provider's skill reaches the session; a disabled one's does not. **No new
      toggle and no new state** — the decision already exists and is already made in that page.
- [x] `hosty mcp`: the connector serves an enabled app's skill to the client it is connected to,
      by whatever mechanism that client supports — the deliverable that turns a stored file into a
      thing an agent reads.
- [x] Demo App: a skill worth reading, as the worked example — procedure, not a tool list.
- [x] Tests: the manifest pairs (escaping refused beside legitimate accepted, non-markdown refused,
      no `agent` block unaffected); the cross-app gate as a pair, with the interface check verified to
      be what refuses; anonymous and foreign-token callers; a declared-but-unpackaged skill as an
      absence; composition for both readers beside their no-skill cases; and the session pair — a
      skill present when the provider is on, absent when it is off.
- [x] **A changed skill is withheld until reviewed.** Shipped 2026-08-20 without reviving the per-app
      flag: the approval is a digest per app in the gateway's settings, beside the provider toggle.
      First sighting is delivered and recorded — enabling was the decision — and a later change is
      withheld, surfaced on the settings page with the new text, and approved against the digest that
      was on screen.

- [ ] Tests: the **vendoring** byte budget. The delivery cap (8,000 characters per app) is asserted;
      that the shared install-time budget refuses an oversized skill is not, because the vendoring
      path has no test harness of its own and adding one is larger than this feature.
- [x] Docs: `feature.md`, the manifest reference in `skills/hosty-app-skill`, index.

## Phases

1. **The contract**: manifest field, validation, vendoring, projection. Nothing reaches an agent yet.
2. **The decision**: none of its own — the skill follows the provider toggle that already exists.
3. **The delivery**: the gateway and the connector hand a skill to their client, and Demo App
   ships one.

## Decisions

Recommended in chat and approved by the owner on 2026-08-20. Recorded with their reasoning, so a
later reader sees why rather than only what.

- **The declaration sits beside the agent-facing surface, not in `metadata`** — `agent.skillFile`, a
  sibling of `interfaces`. `metadata` is documented in Core's own source as "display-only, outside
  runtime validation", and a skill is neither. Putting it there would mean either weakening that
  boundary or shipping a field that behaves unlike its neighbours. The placement also documents
  intent: an author reading `interfaces` sees "this is for agents"; one reading `metadata` sees
  "this is for the catalog".

- **The skill follows the MCP provider toggle; there is no separate switch.** Corrected on
  2026-08-20, during implementation, after the owner asked what a second flag would decide. It would
  ask the same question twice: enabling a provider already accepts that this app's text enters the
  model's context, because a tool arrives with its name and description and there is no version of it
  that does not. An operator who cannot explain the difference between two toggles on one page is
  looking at a design error, not at a choice.

  Two things I had recorded here were wrong and are withdrawn. There is no platform-level provider
  policy for this to sit beside — `mcpProviders` belongs to the **gateway**, one app among others,
  which can be uninstalled. And the connector's lack of an operator toggle is not a gap: the CLI
  reaches Core over the local control channel, which the repository already documents as
  "unconditional host-operator power". A gate there would protect against someone who can already
  remove the app.

- **The skill reaches Hosty's own assistant, under that same decision.** The assistant runs on the host
  with shell access and is the highest-consequence reader — but that argues for the gate, which
  exists, not for exclusion. The decisive point is consistency: the assistant **already** receives
  app-authored text, namely the names and descriptions of every enabled provider's tools, through
  this very toggle. Excluding skills would draw a line drawn nowhere else, and on a host where the
  assistant is how people work it would make the feature nearly pointless.

- **A changed skill is withheld until reviewed.** The asset is already vendored and versioned, so a
  digest change is cheap to detect; on change the skill stops being delivered until the operator
  looks at the new text. Delivering the previous version instead is worse — it is text the installed
  app no longer contains.

  **This is stricter than the platform is today**, and deliberately: an app update currently changes
  its tool *descriptions* silently while the provider stays enabled. That is a gap on that side
  rather than a reason to open one here, and it is recorded so the inconsistency is a known debt
  instead of a discovery.

- **One skill per app**, not one per `interfaces.mcp` entry. That is how a human documents an app,
  and an app with two interfaces still has one story about how it is worked. If it ever needs
  division, that is sections in the file rather than a new axis in the manifest — and this answer is
  what makes a sibling of `interfaces` the right shape above rather than something nested.

## Verification

- Live: an app declaring a skill, disabled, reaches a connected agent with nothing; enabled, the
  agent's behaviour visibly changes on a task where the skill's procedure differs from the obvious
  one. **The negative matters most** — a skill that is delivered while disabled is the failure this
  design exists to prevent.
- A skill declaration pointing outside the app folder is refused at install, not at read time.

## Prerequisite — met

The matrix cell in [ai-agent-bridge](../ai-agent-bridge/plan.md) is closed as of 2026-08-20: a
headless `claude -p`, run outside the repository and told not to read files, answered a
connector-specific question with the skill's own fail-closed rule. A loaded skill demonstrably
supplies facts the model otherwise lacks, which is the assumption this feature rests on. It was
checked before implementation rather than after, because a negative would have invalidated the
design rather than the code.
