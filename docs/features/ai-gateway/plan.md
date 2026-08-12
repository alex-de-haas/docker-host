# AI Gateway — Next Iteration

Status: In Progress
Created: 2026-08-09
Updated: 2026-08-11

Two changes to the shipped assistant ([feature.md](feature.md)): the operator can be **asked a
question**, and the operator can **configure the assistant** in a UI of its own. Kept in one plan and
one PR — the settings surface is where several of the question-related and runtime-related affordances
have to live, so splitting would ship halves that cannot explain themselves.

## Goal

Close the gap between "the assistant works" and "the assistant is operable".

Today an operator gets a chat panel and nothing else: no way to see or change the system prompt, and no
way to choose which apps the agent may reach. The assistant also cannot ask a clarifying question — it
tries, and the attempt visibly fails.

## Target Behavior

Written as a diff against [feature.md](feature.md).

### A. Questions

- The harness can **ask the operator a question** and receive the answer: one to four questions, each
  with two to four options carrying a label and description, single or multi select, plus free-text
  "other".
- A question is **not an approval**. It is a third branch alongside auto-allow and the approval card:
  same pause point, different payload, different card, different resolution. Approving the act of
  being asked a question is nonsense, and it is exactly what happens today.
- Pending questions replay on reconnect as pending approvals already do, cancelling the session
  resolves them, and a second answer to the same question is a 409 like a second approval decision.

**Mechanism (settled 2026-08-11 against `@anthropic-ai/claude-agent-sdk` 0.3.226, from the shipped
types — not assumed).** `AskUserQuestionInput` carries an optional `answers` field, documented as
"User answers collected by the permission component", keyed by question text, alongside optional
`annotations`. The designed flow is therefore:

1. the model calls `AskUserQuestion` with `questions` and no `answers`;
2. the host pauses in `canUseTool`, renders the question, collects the operator's choice;
3. the host resolves with `{behavior: 'allow', updatedInput: {...input, answers}}`;
4. the tool runs and returns the answers to the model as an ordinary tool result.

This is why neither workaround considered earlier is needed: no answer smuggled through a `deny`
message (which risked reading as a refusal and reproducing the current loop), and no replacement tool
registered through an in-process MCP server (which risked the model not reaching for it).
Multi-select answers are a comma-separated string in one value, and "other" free text is part of the
contract, so the card must accept it.

Unrelated but adjacent, so it does not get discovered the hard way: the SDK also has an
`onUserDialog` / supported-dialog-kinds channel for CLI-driven dialogs such as
`refusal_fallback_prompt`. It is **fail-closed** — a kind that is not declared degrades to the
no-dialog behavior. That is the correct default for us; declaring a kind we cannot render would park
a dialog we then mishandle. Leave it unset.

Current behavior, for contrast: `AskUserQuestion` is absent from `AUTO_ALLOWED_TOOLS`
(`src/harness/claude.ts`), so it raises an approval card; allowing it passes the input through
unchanged, so the tool runs with no `answers` and reports that the questions were not answered, and
the model falls back to asking the operator to restate the request in prose. Both halves are defects
and neither is fixed by the other — adding the tool to the auto-allow list alone removes the card and
keeps the dead end, which is worse, because the operator loses even the signal that something
happened.

### B. Settings Surface

- The gateway gains a `ui` block and appears as its own **sidebar section**, the way
  `hosty.marketplace` and `hosty.telemetry` already do — those get their navigation entries purely
  from `ui.navigation`, and the gateway's manifest simply has no such block today. Pages are served
  from the existing Node process; nothing needs splitting out (telemetry only split because its
  backend is .NET).
- The section holds:
  - **System prompt.** Operator-authored text **appended to** the harness's own instruction sources,
    never replacing them. The Claude adapter runs with `settingSources: ["user", "project"]`, so the
    operator's own `CLAUDE.md` and skills already flow in; silently displacing them would make the
    agent stop behaving the way the same operator's CLI does, with nothing on screen explaining why.
  - **MCP providers.** Installed apps declaring an `mcp` interface, read from Core, with a per-app
    toggle. **New apps default to off.** Tool names and descriptions are third-party text that lands
    in the context of a model holding host shell, so an app appearing in the fleet must not silently
    gain a channel into the agent — enabling it is a decision, not a side effect of installing
    something.
  - **Harness and credentials.** Selected harness, credential state, and the health reason when it is
    unusable. These live in generic key/value app settings today, which cannot render the list above.
- **Where state lives:** Core stays the registry (which apps exist, which declare `mcp`, at what URL);
  the gateway owns the policy (which are enabled). Toggles never go into Core.

## Deliverables

### This iteration

- [x] Questions as a distinct resolution kind end to end: harness adapter contract, gateway event and
      event-log record, resolution route (409 on a second answer), SSE replay, cancellation.
- [x] `canUseTool` branch for `AskUserQuestion` that resolves with `updatedInput.answers` rather than
      a bare allow.
- [x] Shell question card: options with label and description, single and multi select, free-text
      other, visually distinct from an approval card, rebuilt from the event log on reconnect.
- [x] Harness capability flags: whether the harness can ask questions, and whether it can be
      reconfigured live. A harness lacking either reports that instead of hanging or silently
      ignoring a toggle, and the UI states what actually happened.
- [x] `ui` block in the manifest plus the settings pages in B, served from the gateway process.
- [x] Policy store for MCP-provider enablement: defaults to off, survives restart, prunes entries for
      uninstalled apps.
- [x] System-prompt storage and its append (not replace) wiring into both harnesses.
- [x] Umbrella execution-profile rationale revised so it no longer reads as "no mitigation needed"
      (documentation only, no version bump) — see Accepted Risk.
- [x] **Provider discovery from Core.** Closed 2026-08-11 by extending
      `/api/internal/apps/{appId}/app-directory` with declared interfaces — see
      [app-mcp](../app-mcp/feature.md) for the decision and its disclosure boundary.
- [x] `feature.md` updated, index regenerated.

Version outcome: `apps/ai-gateway` 0.5.2 → 0.6.0, `apps/shell` 0.54.0 → 0.55.0 (the question card).

### Deferred — deliberately not in this iteration

Kept as unchecked deliverables rather than moved to prose, so the work stays visible. Neither is
started, and this plan is not deleted while they remain.

- [ ] **Runtime containment.** A docker runtime profile made default, with `localCommand` retained as
      an explicit opt-in and its trade-off stated in the settings UI; the never-mount rules (docker
      socket, Core's control/run directory, `~/.hosty` wholesale) enforced by the profile rather than
      by convention. Parked 2026-08-11: the assistant is admin-only, so the exposure is bounded to
      administrators. Note this bounds *who* can start a session, not the risk inside one — see
      Accepted Risk.
- [ ] **App-provided skills.** Per-app instruction bundles with inspect-before-enable and off by
      default. Parked 2026-08-11. An MCP tool is a typed call approved per invocation; a skill is
      instructions the model follows, with no approval between an app's text and the agent's behavior.
      That trust step deserves its own decision rather than riding along.

## Accepted Risk

Recorded because deferring containment is a choice, and the reasoning must not be reconstructed from
silence later.

The umbrella ([ai-agent-bridge](../ai-agent-bridge/plan.md)) justifies the operator profile on the
grounds that it "grants no privilege an administrator does not already have over SSH — that
equivalence is the justification for the profile, not a mitigation to be improved later." The
equivalence assumes the administrator decides what runs. Operator sessions also consume live logs and
app data, which the same document calls untrusted model input, and answers with the approval gate.
That leaves **one boundary, and it is human attention**: the operator sees a command, not its
consequence, and behind an approved `Bash` call the `hosty` CLI has unconditional host-operator power
with no authentication at all.

Restricting the assistant to administrators — already true, enforced in `src/auth.ts` on every route
and in Shell's surface gating — does not reduce this. The risk lives inside an admin's own session,
and injected instructions execute with that admin's privileges.

The umbrella text is therefore revised in this iteration to state the residual risk and name
containment as the fix, so the next reader does not find an argument implying the problem is settled.
Only the wording changes; no containment work ships here.

## Phases

All phases ship on one branch and one PR, per `AGENTS.md`.

1. **Questions.** Self-contained and fixes a defect visible today; the mechanism is settled, so this
   starts with implementation rather than a spike.
2. **Settings shell.** `ui` block, sidebar entry, system prompt, harness and credential pages.
3. **MCP policy page.** Storage, defaults, rendering. Enablement is *recorded* here, not yet consumed
   by a session — see Dependencies.

## Dependencies

Wiring enabled MCP providers into a running session needs two things this plan deliberately does not
own: a Core endpoint listing MCP endpoints resolved from the caller's vantage point, and **token
exchange** — Core accepting the gateway's delegated token (audience = the gateway) and returning one
for the same subject with the target app's audience, so the acting user's identity reaches the app.
Those belong to the connector/discovery feature and are its deliverables, not duplicated here.

Phase 3 stopping at recorded policy is a clean seam, not a compromise: the list of apps declaring
`mcp` is already obtainable from Core today, and only *calling* them needs the exchange.

## Decisions

Recorded with their reasoning, because the reasoning is what a reader needs when the code later looks
arbitrary. No open questions remain.

- **One feature, not three** (2026-08-11, owner). The settings surface is where the runtime and policy
  affordances live, so splitting would ship a change with nowhere to explain itself.
- **Containment is not in this iteration** (2026-08-11, owner) — see Deferred and Accepted Risk.
- **App-provided skills are not in this iteration** (2026-08-11, owner) — see Deferred.
- **An answer reaches the model through `updatedInput.answers` on `canUseTool`** — verified against
  the shipped SDK types rather than assumed. See Target Behavior A.
- **Codex has a question mechanism: `item/tool/requestUserInput`.** It sits in the same
  server→client request family as the three approval methods this adapter already drives, read out of
  the pinned `@openai/codex` 0.147.0 binary. The method exists; its request payload and response shape
  are not visible that way, so implementation pins them in `codex-protocol.ts` and enforces them with
  the scripted test fake, exactly as the approval vocabularies already are. That is where this adapter
  has burned us twice: a wrongly shaped reply is accepted at the wire level and then silently does
  nothing, which is indistinguishable from a harness that never answers.
  (`mcpServer/elicitation/request` is adjacent but different — an MCP server eliciting input — and
  matters once app MCP providers are wired in, not here.)
- **Settings apply per setting, not by one rule.** An earlier version of this plan claimed a harness
  fixes its MCP server list at session start. That is true of stock clients; the gateway is not one —
  it drives the SDK, and `Query` exposes `setMcpServers`, `toggleMcpServer` and `reconnectMcpServer`.
  Codex shows no equivalent (only `mcpServer/startupStatus/updated` and relatives), so the behavior is
  harness-dependent. Therefore:
  - **MCP toggles apply immediately** where the harness supports it. Disabling especially: an operator
    switching a provider off mid-session is acting on an intent that deferring would invert. Enabling
    applies immediately too, because a toggle that switches off now but on later is behavior nobody
    will remember.
  - **The system prompt applies at the next session.** It is the session's instruction set, not a live
    connection; swapping it mid-conversation yields a transcript whose halves ran under different
    instructions, and the agent stops being explainable.
  - **The harness is never restarted to apply a setting** — that discards agent state and breaks the
    conversation for a configuration change.
  - Live reconfiguration does **not** erase context. Disabling a provider stops further calls; its
    tool descriptions and any earlier calls remain in the conversation. "Off" is enforced at the call,
    not by the model forgetting, and the UI should not imply otherwise.

## Verification

- Gateway (vitest): question round trip against the fake harness — asked, answered, `answers`
  delivered in `updatedInput`; 409 on a second answer; replay of a pending question after reconnect;
  cancellation resolving a pending question; capability flag honored. Policy store: defaults to off,
  survives restart, prunes uninstalled apps.
- **The question path is verified by the answer being acted on, not by the card closing.** A round
  trip that renders, closes, and delivers nothing usable is indistinguishable from a working one at
  the UI level — the same trap that produced two near-miss bugs in the Codex adapter, where only
  testing the *allow* direction revealed the gate was doing nothing.
- Shell: eslint and `next build` gate the surface as before; the question card is verified live — ask
  a question with options, choose one, and confirm the agent continues along the chosen option rather
  than restating the request.
- Live: install, set a credential, run a chat turn, and confirm both that a proposed write still
  pauses and that an approved one still executes.
