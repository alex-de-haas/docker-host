# AI Gateway — Harness Selection And Codex Adapter

Status: Draft
Created: 2026-08-09
Updated: 2026-08-09

Follow-up to [feature.md](feature.md), written as a diff against it. The umbrella decision
(2026-07-11, [ai-agent-bridge](../ai-agent-bridge/plan.md)) made agent harnesses replaceable
clients, never the contract; the shipped gateway honors that at the adapter seam but exposes no
operator-facing choice and ships one real adapter. This plan adds the choice and the second
adapter: OpenAI Codex CLI.

## Goal

An administrator picks which agent harness powers operator sessions — Claude (Agent SDK, shipped)
or OpenAI Codex CLI — as ordinary gateway app configuration, with identical supervision semantics:
every write pauses for approval in Shell, transcripts and audit behave the same, and the harness
choice never leaks above the adapter seam.

## Target Behavior (diff vs feature.md)

- The gateway manifest gains a harness selection setting (enum-like string, `claude` | `codex`,
  default `claude`). The internal `HOSTY_AI_GATEWAY_HARNESS` env keeps working and keeps `fake`
  for tests; the setting is the operator surface over it.
- A Codex adapter implements the existing `HarnessAdapter` contract (start / send /
  resolveApproval / interrupt / stop + events) over Codex's programmatic interface, pinned to a
  specific Codex version. Approval parity holds: read-only actions run unprompted, command
  execution and patches pause until the operator decides; deny carries a message back.
- Codex credentials follow the Claude pattern: optional secret app settings (API key / auth as
  Codex requires), and the health probe reports the selected harness with a missing-binary or
  missing-credential reason — Shell's "assistant unavailable" state needs no changes.
- `/healthz` and `/api/health` report the *selected* harness only.

## Deliverables

- [ ] Spike: drive Codex CLI through its protocol interface (`codex app-server` / proto JSON-RPC,
  not `codex exec`) and grade it on the same three criteria as the Claude spike — approval-pause
  fidelity (exec/patch approval requests must block until answered), streaming event quality, and
  resumability. Record the outcome in this document; it decides whether the adapter ships or the
  plan is revised.
- [ ] Harness selection as an operator setting on the gateway manifest, wired through config; the
  probe and session start use the selected adapter only.
- [ ] Codex adapter implementing `HarnessAdapter`, pinned Codex version, with a probe that detects
  the binary and its auth state.
- [ ] Codex credential secret settings, mirrored from the Claude ones.
- [ ] Tests: adapter behaviors against a scripted fake of the Codex protocol (approval pause,
  deny, error recovery), selection wiring, health reasons; `tsc` clean.
- [ ] Docs: fold the shipped behavior into `feature.md`, delete this plan, note in the umbrella
  that the 2026-07-11 "codex exec cannot pause per call" premise was re-examined against the
  protocol interface, and regenerate the index.

## Open Questions

- Question: Which Codex interface does the adapter drive?
  Answer: The 2026-07-11 limitation ("cannot pause per tool call") was recorded against headless
  `codex exec`. Codex's protocol interface (used by its IDE integrations) surfaces exec/patch
  approval requests as protocol events, which is exactly the pause the gateway needs — but this
  is unverified here.
  Recommendation: The protocol interface; the spike confirms or refutes and its outcome is
  binding.

- Question: How is the Codex version pinned — npm dependency or operator-installed binary?
  Answer: Codex CLI is distributed via npm (native binary wrapper), so a pinned dependency in the
  gateway's package.json mirrors the Claude approach; an operator-installed binary would drift.
  Recommendation: Pin as a package.json dependency, with `pathToCodex`-style override left to a
  future need.

- Question: App-level harness choice only, or per-session?
  Answer: Per-session choice needs UI, per-session credentials resolution, and mixed-harness
  transcripts; app-level covers the stated need (operator picks their agent).
  Recommendation: App-level only in this plan; per-session is out of scope.

- Question: How do Codex's tool semantics map onto the read-only auto-allow list?
  Answer: Codex's action vocabulary (commands, patches) differs from Claude's named tools; a
  wrong mapping either nags on reads or silently allows writes.
  Recommendation: Fail closed — anything the protocol reports as a command execution or file
  change pauses; only explicitly read-only protocol actions auto-run. Decide the exact mapping
  during the spike.

## Verification

- Vitest: scripted-protocol adapter suite (turn, approval allow/deny, error → fresh run), harness
  selection, probe reasons.
- Live checklist: select Codex in the gateway settings, provide its credential, restart the app;
  run a chat turn from Shell; confirm a proposed command pauses on an approval card, executes only
  after Allow, and a deny returns a message; confirm `/healthz` names the codex harness; switch
  the setting back to Claude and confirm sessions run unchanged.
