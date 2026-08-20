# App-Provided Skills

Status: Draft
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

- [ ] Manifest: an optional skill declaration, validated like the other asset paths (relative,
      contained, `.md`, size-capped) and **rejected when it names anything outside the manifest
      folder**.
- [ ] Core: vendoring and serving through the existing asset endpoint, reusing the byte budget rather
      than adding a second one.
- [ ] Core: the per-app enablement, stored beside the MCP provider policy it mirrors, defaulting to
      off, and exposed on the app projection so a client can tell enabled from merely declared.
- [ ] Shell: the operator's decision surfaced where the MCP provider toggle already is, saying what
      enabling means in the same plain terms that section already uses.
- [ ] `hosty mcp`: the connector serves an enabled app's skill to the client it is connected to,
      by whatever mechanism that client supports — the deliverable that turns a stored file into a
      thing an agent reads.
- [ ] Demo App: a skill worth reading, as the worked example — procedure, not a tool list.
- [ ] Tests: a declaration outside the manifest folder refused beside a legitimate one accepted; a
      declared-but-disabled skill absent from what a client receives beside an enabled one present;
      the byte budget enforced.
- [ ] Docs: `feature.md`, the manifest reference in `skills/hosty-app-skill`, index.

## Phases

1. **The contract**: manifest field, validation, vendoring, projection. Nothing reaches an agent yet.
2. **The decision**: per-app enablement, Shell surface, defaults.
3. **The delivery**: the connector hands an enabled skill to a client, and Demo App ships one.

## Open Questions

1. **Where does the declaration live?** `metadata` holds the display assets and is documented as
   outside runtime validation — a skill is not display-only, so putting it there weakens a boundary
   that currently means something. The alternative is beside the agent-facing surface the app already
   declares (`interfaces.mcp`), which reads as "this is for agents" rather than "this is for humans
   browsing a catalog".
2. **Does the skill reach Hosty's own assistant, or only external clients?** The gateway runs on the
   host with shell access, so it is the highest-consequence reader; it is also the one Hosty fully
   controls, so it is the easiest to gate. Both arguments point in opposite directions.
3. **What happens when an update changes the skill?** Re-asking the operator on every change is the
   safe reading and the annoying one; not asking means an update silently rewrites instructions an
   operator once approved. A middle option — re-ask only when the file's digest changes — is
   implementable because the asset is already vendored and versioned.
4. **One skill per app, or one per MCP interface?** An app may declare several `interfaces.mcp`
   entries. One skill is simpler and matches how a human would document an app.

## Verification

- Live: an app declaring a skill, disabled, reaches a connected agent with nothing; enabled, the
  agent's behaviour visibly changes on a task where the skill's procedure differs from the obvious
  one. **The negative matters most** — a skill that is delivered while disabled is the failure this
  design exists to prevent.
- A skill declaration pointing outside the app folder is refused at install, not at read time.

## Prerequisite

The matrix cell in [ai-agent-bridge](../ai-agent-bridge/plan.md) — *"a Hosty skill … validated with
the skill loaded"* — is still open: both validated connections were made with a bare `mcp add`, so
**nothing has yet demonstrated that a loaded skill changes an agent's behaviour at all**. Building
app-provided skills on top of that assumption would be building on an unverified base. Close it
first; it is one Claude Code run with the plugin installed.
