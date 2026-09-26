# Assistant Runtime Containment

Status: On Hold
Created: 2026-09-26
Updated: 2026-09-26

Run the assistant's agent harness inside a container by default, so a session's approved commands
act on what the container can reach rather than on the whole host. Extracted on 2026-09-26 from the
last open deliverable of the [AI Gateway](../ai-gateway/feature.md) iteration plan, which shipped
everything else and was closed in the same change. The work was parked there on 2026-08-11 by the
owner and stays parked here: On Hold records that decision rather than an approval to start. Moving
it to Draft and then Ready is the owner's call.

## Current Behavior

- `apps/ai-gateway` has two `localCommand` profiles, `local` (default) and `dev`. The gateway spawns
  the Claude and Codex harness processes on the host as the OS user running Core, so it never runs
  in a container ([feature.md](../ai-gateway/feature.md#gateway-app)).
- A session's shell calls therefore run with that user's full authority. The host preamble points the
  model at the local `hosty` CLI for lifecycle actions, which the delegated Core MCP credential
  refuses; behind an approved `Bash` call the CLI has unconditional host-operator power over the local
  control channel.
- The "never mount" rules — the Docker socket, Core's control/run directory, `~/.hosty` wholesale —
  hold only by convention: nothing mounts them because nothing is a container.

## Target Behavior

Written as a diff against [ai-gateway/feature.md](../ai-gateway/feature.md).

- The assistant app ships a `docker` runtime profile, and that profile is the default. The image
  carries pinned harness CLIs (Claude, Codex) and the gateway itself.
- `localCommand` stays available as an **explicit opt-in**. The settings surface shows which profile
  is running and states the trade-off: host-native toolchains and host logins in exchange for no
  containment.
- The never-mount rules are **enforced by the profile**, not by convention: Core refuses to start the
  assistant's container with the Docker socket, Core's control/run directory or the whole data root
  mounted, whatever the manifest or an override requests.
- Under the docker profile a session reaches the host only through what it is given: its assigned
  data and cache directories, the source workspaces its session is authorized to edit, and Core's
  HTTP/MCP surface under the grants the app and the session actually hold. Lifecycle actions go
  through Core with those grants instead of the host CLI.

## Accepted Risk

Recorded because deferring containment is a choice, and the reasoning must not be reconstructed from
silence later. Moved here unchanged in substance from the closed AI Gateway plan.

The residual risk is stated in the umbrella
([ai-agent-bridge](../ai-agent-bridge/feature.md#accepted-risk)): the SSH-equivalence argument does
not settle the matter, because operator sessions consume live logs and app data — untrusted model
input — and the approval gate is then the one boundary left, human attention on a command rather
than its consequence, with the `hosty` CLI's unconditional host-operator power behind any approved
`Bash` call.

Restricting the assistant to administrators — already true, enforced in `src/auth.ts` on every route
and in Shell's surface gating — does not reduce this. The risk lives inside an admin's own session,
and injected instructions execute with that admin's privileges. Containment is the fix; until it
ships the risk is accepted, not absent.

## Interactions With Other Plans

Checked against `origin/main` at `f2bae944` (2026-09-26). None of these implements or contradicts
containment; each changes what it has to cover.

- **[Hosty Harness rename](../hosty-harness-rename/plan.md)** (Draft) replaces `hosty.ai-gateway`
  with a freshly installed `hosty.harness` and explicitly migrates no state. Containment lands in
  whichever manifest is current when it ships. If it ships with or after the rename, the default
  profile changes on a clean install, so no data move between a host directory and a container
  volume is needed.
- **[Assistant provider permissions](../assistant-provider-permissions/plan.md)** (Ready) and the
  [core extension model](../core-extension-model/plan.md) give the assistant confirmed Core
  permissions, and state that for a `localCommand` app those grants are an honest label rather than
  an enforced boundary. Under the docker profile they become the boundary, because Core's API is the
  only way in. Nothing here changes the permission model.
- **[Session workspaces](../assistant-session-workspaces/plan.md),
  [prototype workspaces](../app-prototype-workspaces/plan.md) and the
  [development sessions](../assistant-development-sessions/plan.md) umbrella** (Draft) have the
  harness edit Core-allocated source that appears per session. Container mounts are fixed at
  creation, so a contained harness needs a stable, scoped way to reach those workspaces without the
  whole data root — see Open Questions. Their Git metadata boundary must hold inside the container
  too.
- **[AI Gateway provider connections](../ai-gateway-providers/feature.md)** keep managed native homes
  under the app cache, which a container can own. The "existing host login" mode points at an
  arbitrary host path and has no direct container equivalent.
- **[App sandbox runtimes](../app-sandbox-runtimes/plan.md)** (Draft) isolates the *apps* an agent
  builds and tests; this plan isolates the *harness* that runs the agent. They share research —
  Docker Desktop networking on macOS/Windows, egress control, non-privileged containers — and must
  not duplicate each other's deliverables.
- [Vision](../../vision.md) decisions 12 and 15 say agents run on the host rather than on the
  client device. A container on the host is consistent with that; the decisions do not require
  host-native processes.

## Deliverables

- [ ] Container image for the assistant (gateway plus pinned Claude and Codex CLIs), built and
      published with the app's release, and a `docker` runtime profile in its manifest.
- [ ] The `docker` profile is the default; `localCommand` remains an explicit opt-in, and the
      settings surface shows the active profile and states the trade-off.
- [ ] Core enforces the never-mount rules for the assistant's container (Docker socket, Core
      control/run directory, whole data root), refusing the start rather than warning, with negative
      tests for each path and for an override that requests one.
- [ ] Scoped source-workspace access for contained sessions, aligned with session workspaces: edit,
      build and diff work on the authorized workspace and nothing else.
- [ ] Provider connections work contained: managed native homes in the container's data/cache, and
      the chosen behavior for the "existing host login" mode.
- [ ] Lifecycle actions without the host CLI: the host preamble and approval flow route them through
      Core's API/MCP under the app's and session's grants, and the settings surface says what a
      contained session cannot do.
- [ ] [ai-gateway/feature.md](../ai-gateway/feature.md) and the umbrella's accepted-risk section in
      [ai-agent-bridge/feature.md](../ai-agent-bridge/feature.md#accepted-risk) updated to the
      shipped state, this plan deleted and the index regenerated.

## Open Questions

1. When does this leave On Hold — stay parked, or ship together with the Hosty Harness rename, whose
   fresh install makes the default-profile change free of data migration?
2. How does a contained harness reach per-session workspaces: one stable workspace-root mount that
   Core allocates under, a container restart when a workspace is added, or Core-brokered file
   operations?
3. The "existing host login" provider mode: unavailable under the docker profile, or the selected
   home mounted read-only?
4. Which platforms are supported first, given Docker Desktop's bind-mount performance and networking
   on macOS/Windows? Share the egress-policy decision with app sandbox runtimes.
5. Does a contained session keep any command-line path to Core (for example the `hosty` CLI talking
   HTTP with a scoped token), or only MCP tools?

## Verification

- A clean install through Core starts the assistant as a container (`docker ps`), with no gateway or
  harness process on the host; switching to `localCommand` requires an explicit choice and shows the
  trade-off in the settings surface, checked through Shell rather than standalone.
- `docker inspect` of the assistant's container shows none of the never-mount paths; a manifest or
  override requesting any of them is refused at start, covered by Core tests.
- A provider-backed Claude turn and a Codex turn run end to end in the container; a proposed write
  still pauses for approval and an approved one executes; a session edits its authorized workspace
  and cannot read another app's data or the Core data root.
- A lifecycle action requested in a contained session goes through Core under the held grant and is
  refused without it — verified by the action being refused or performed, not by the card closing.
