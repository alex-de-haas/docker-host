# AI Gateway — Harness Selection And Codex Adapter

Status: In Progress
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

- [x] Spike: drive Codex CLI through its protocol interface (`codex app-server` / proto JSON-RPC,
  not `codex exec`) and grade it on the same three criteria as the Claude spike — approval-pause
  fidelity (exec/patch approval requests must block until answered), streaming event quality, and
  resumability. **Outcome: go** — see Spike Outcome below.
- [x] Harness selection as an operator setting on the gateway manifest, wired through config; the
  probe and session start use the selected adapter only. (`HOSTY_AI_GATEWAY_HARNESS`, values
  `claude` | `codex`; an unrecognized value falls back to `claude` rather than failing startup.)
- [x] Codex adapter implementing `HarnessAdapter`, with a probe that detects the binary and its
  auth state. Verified live against `codex-cli 0.147.0`: approvals paused, denials refused the
  action, and the file the model tried to create was never created.
- [x] Codex credential secret settings, mirrored from the Claude ones (`CODEX_API_KEY`, or an
  operator `codex login` on the host, which the probe reports on).
- [x] Tests: adapter behaviors against a scripted fake of the Codex protocol (handshake, resume,
  streaming, approval allow/deny, denied-item suppression, process death, missing binary) plus the
  selection mapping; `tsc` clean.
- [ ] Docs: fold the shipped behavior into `feature.md`, delete this plan, note in the umbrella
  that the 2026-07-11 "codex exec cannot pause per call" premise was re-examined against the
  protocol interface, and regenerate the index.

## Spike Outcome (2026-08-09) — go

Run against `codex-cli 0.147.0` on macOS, driving `codex app-server` over stdio JSON-RPC. The
2026-07-11 "cannot pause per tool call" limitation holds for `codex exec` only; the app-server
protocol clears all three criteria.

- **Approval-pause fidelity: yes, and it is a blocking request, not an event.** Approvals arrive as
  *server→client JSON-RPC requests carrying an `id`* — `item/commandExecution/requestApproval` and
  `item/fileChange/requestApproval` — and the action does not proceed until the client answers that
  id. This is a better fit than a fire-and-forget event: the protocol itself models the pause the
  gateway needs, exactly like the Agent SDK's `canUseTool`. Verified end to end: the probe asked for
  a file to be created, denied all three approval requests, and the file was never created.
- **Streaming: yes.** `item/agentMessage/delta` carries incremental assistant text (10–14 deltas per
  turn in the probe), alongside `item/started` / `item/completed` for typed items (`commandExecution`,
  `fileChange`, `reasoning`) and `turn/completed` for the terminal event.
- **Resumability: yes, across processes.** `thread/start` returns a `threadId`; after killing the
  app-server process, a fresh one accepted `thread/resume` with that id and the model recalled a
  token from the pre-restart turn. This maps onto the record's existing `harnessSessionId`.

Protocol notes for the adapter (all learned the hard way in the spike — the vocabulary is not
uniform):

- Handshake is `initialize` (request) then an `initialized` notification.
- `thread/start` takes `sandbox` as a **plain string** (`"read-only"` | `"workspace-write"` |
  `"danger-full-access"`), but `turn/start` takes `sandboxPolicy` as an **internally tagged object**
  (`{ "type": "readOnly" }`). Sending either form to the other endpoint is a `-32600`.
- `approvalPolicy` accepts `"untrusted"` | `"on-request"` | `"never"` (or a granular object).
  `"untrusted"` still auto-runs Codex's trusted-command list (`echo` ran unprompted in the probe) —
  which is why the gateway's own read-only allowance must be enforced by the adapter, not delegated
  to this setting.
- The approval response is `{ decision }` where a denial is `{ "denied": { "rejection": "<text>" } }`
  and an allow is the bare string `"approved"` (`"approved_for_session"` also exists — the gateway
  must never use it: it would grant blanket approval and break the every-write-asks rule).
- After a denial Codex retries with a different strategy (patch → patch → shell command in the
  probe) rather than stopping. The deny message is therefore load-bearing: it must state that the
  operator refused, so the model stops instead of hunting for a way around the refusal.
- **Codex emits `item/completed` for a REFUSED item too** (found while verifying the shipped
  adapter live, not in the protocol probe). Taken at face value that reports a denied command as
  executed, so the adapter tracks the approval's `itemId` and suppresses the tool-use event for a
  refused item; the scripted test fake reproduces this so the suppression cannot regress.

## Open Questions

- Question: Should a denial end the turn instead of letting Codex retry another approach?
  Answer: The spike saw three successive approval requests for one refused instruction, each a
  different mechanism. Claude's harness stops on a denial; Codex treats it as one blocked path.
  Recommendation: Keep the protocol behavior but make the deny text explicit ("the operator
  refused this action; do not attempt it another way"), and let the operator use Cancel for a hard
  stop. Re-evaluate if it still loops in practice.

- Question: How is the Codex version pinned — npm dependency or operator-installed binary?
  Answer: Codex CLI is distributed via npm (native binary wrapper), so a pinned dependency in the
  gateway's package.json mirrors the Claude approach; an operator-installed binary would drift.
  The probe ran against an operator-installed `codex-cli 0.147.0` on PATH, which also worked.
  Recommendation: Pin as a package.json dependency and resolve the binary from it, falling back to
  PATH so an operator install still works; the probe's protocol quirks are version-sensitive, so
  the pin is what the adapter's tests are written against.

- Question: App-level harness choice only, or per-session?
  Answer: Per-session choice needs UI, per-session credentials resolution, and mixed-harness
  transcripts; app-level covers the stated need (operator picks their agent).
  Recommendation: App-level only in this plan; per-session is out of scope.

- Question: How do Codex's tool semantics map onto the read-only auto-allow list?
  Answer: Codex's action vocabulary (commands, patches) differs from Claude's named tools; a
  wrong mapping either nags on reads or silently allows writes.
  Decision (2026-08-09, from the spike): fail closed and keep the decision in the adapter. Every
  `item/commandExecution/requestApproval` and `item/fileChange/requestApproval` becomes a Hosty
  approval card; nothing is auto-allowed on Codex's behalf. Reads never raise an approval request
  in the first place (the sandbox handles them), so no allow-list is needed — and Codex's own
  `approvalPolicy: "untrusted"` trusted-command carve-out must not be relied on, since it silently
  ran `echo` unprompted in the probe.

## Verification

- Vitest: scripted-protocol adapter suite (turn, approval allow/deny, error → fresh run), harness
  selection, probe reasons.
- Live checklist: select Codex in the gateway settings, provide its credential, restart the app;
  run a chat turn from Shell; confirm a proposed command pauses on an approval card, executes only
  after Allow, and a deny returns a message; confirm `/healthz` names the codex harness; switch
  the setting back to Claude and confirm sessions run unchanged.
