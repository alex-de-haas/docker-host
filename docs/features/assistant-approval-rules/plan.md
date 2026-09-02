# Assistant Approval Rules

Status: Draft
Created: 2026-09-02
Updated: 2026-09-02

Operator-owned rules for which assistant actions run without an approval card, beyond the per-app
read-only grant that ships today. This is the "second iteration informed by real usage" that the
[AI Agent Bridge](../ai-agent-bridge/feature.md#approval-posture) deferred when every write became
approval-gated on 2026-08-08. The usage informing it: an operator answering a card for every
`hosty apps update-plan`, and for every repeat of the same command inside one long session.

Everything here is a diff against the shipped assistant in
[ai-gateway](../ai-gateway/feature.md) — its per-app "run read-only tools unprompted" grant, the
Core provider row, and the typed approval cards are the ground this builds on.

## Goal

Let the operator decide, in advance and in the open, which actions of which provider may run without
a card — per tool, for one session, or for a shell command prefix — with every such decision visible
on the settings page, honoured identically by both harnesses, and leaving an audit line whenever it
lets something through.

## Target Behavior

### A. Per-tool policy in settings

- Under each enabled provider's row the settings page can expand **the provider's tool list**, read
  from its `tools/list` the way the facade's catalog and the read-only probe already do: name,
  description, and the app's `readOnlyHint` / `destructiveHint` as labels.
- Each tool carries a mode, **Ask** or **Run unprompted**. Read-only tools inherit the provider's
  existing select and show it greyed; mutation tools are set one by one, never by a provider-wide
  switch. A tool declaring `destructiveHint` carries a warning beside its control.
- A tool the provider stops listing loses its rule at the next settings read, the way an uninstalled
  app loses its toggle today.

### B. Session grants from the card

- The approval card gains **Allow for this session** beside Allow and Deny. For an app or Core tool
  the grant is the tool's name; for a shell command it is the command's first word plus its
  subcommand words up to the first argument that is not a flag (`hosty apps update-plan`), shown on
  the button so the operator sees what they are granting before they grant it.
- Session grants live in the gateway's live session only — never in settings, never in the harness's
  own permission store — and end with the session. A new session starts with none.
- A session grant leaves an audit line when it is made and a line each time it lets a call through.

### C. Shell prefix rules

- Persistent shell rules are **prefix rules in Claude Code's own syntax**, `Bash(hosty apps
  update-plan:*)`, written on the settings page under the Shell heading. The syntax is borrowed so
  an operator who has written one for the CLI need not learn another.
- There is no "run every shell command unprompted": that is `bypassPermissions` under another name,
  and the plan refuses it as a control rather than leaving it to a review to refuse later.
- A command containing `;`, `&&`, `||`, `|`, `$(`, backticks or a newline **never matches a prefix
  rule**, and never matches a session grant: a prefix guards the head of one command, and a compound
  command has more than one head. Fail closed.

### D. Where the policy is evaluated

- **In the gateway, for both harnesses** — the Claude adapter's `canUseTool` branch and the Codex
  adapter's approval-request handler consult the same predicate the per-app grant uses today. Not
  the SDK's `allowedTools`, not `updatedPermissions` written to the harness's own settings: a rule
  the SDK applies on its own bypasses `canUseTool` and with it the audit line, is invisible to the
  settings page, and means nothing to Codex.
- The predicate takes the tool name and the input, since a shell rule is about the command and not
  the tool.

### E. Audit

- A call the policy lets through reports `ai_action_auto_allowed` to Core with the tool name and the
  rule that matched (per-tool, session, or prefix), the way an approved card reports
  `ai_action_approved` today. An unprompted mutation without a trail would be exactly the thing the
  2026-08-08 posture existed to prevent.

## Deliverables

- [ ] **Verify the H2 finding first** (review of 2026-08-18): whether `permissions.allow` rules from
  the operator's own `~/.claude/settings.json`, loaded through `settingSources: ["user",
  "project"]`, pre-empt `canUseTool`. Test live: a `Bash(echo:*)` allow rule in user settings, a
  request to run `echo`, and a check for whether a card appears. If it bypasses, neutralize it
  before any of the below ships — a settings page that claims to list the rules must not be
  contradicted by a file it cannot see. The `Task` auto-allow (H1) is reviewed in the same pass.
- [ ] Rule model in the gateway's settings store: per-tool modes keyed by provider and tool name,
  shell prefix rules, with validation and pruning against the live tool list.
- [ ] One predicate over tool name and input, consulted by both adapters; the Codex adapter's
  approval handler gains the branch it lacks today.
- [ ] Settings page: expandable tool list per provider with per-tool mode and hint labels; a Shell
  section for prefix rules.
- [ ] Card: **Allow for this session**, with the grant it would make shown on the button.
- [ ] Compound-command refusal, unit-tested against every separator listed in C.
- [ ] `ai_action_auto_allowed` audit report with the matching rule, and the Core side accepting it
  like the existing gateway actions.
- [ ] Docs: `feature.md` for this feature; the approval posture in
  [ai-agent-bridge](../ai-agent-bridge/feature.md) revised from "no exceptions, no session-scoped
  approvals" to the rules above; the index regenerated.

## Open Questions

- **Codex and app tools.** Codex raises approval requests for command execution and file changes.
  Whether it raises one for an MCP tool call at all is not established; if it does not, app
  mutations on Codex already run unprompted and this plan's Codex branch is a fix, not a feature.
  Establish it against the pinned binary before D is designed in detail.
- **Core mutations in the panel.** The panel reaches Core with a delegated token, which never carries
  scopes, so Core refuses lifecycle and update tools on it and `update-plan` / `update` stay on the
  CLI. Giving the panel a credential that can carry `mcp:lifecycle` / `mcp:update` for the operator's
  own session is what turns those into typed tools with typed cards — and what makes a per-tool rule
  for `plan_app_update` possible. Either extend the delegated token with the grants a session-minted
  chain may carry, or mint a scoped credential for the session; both are Core changes and neither
  is chosen here.
- **Tool results in the transcript.** The transcript shows a tool's input and never its result; a
  collapsed result under a shell row would tell the operator what the assistant saw. Results land in
  the persisted event log, so `cat` of a secret file would put the secret on disk in a transcript —
  a decision about redaction or a size cap has to come first.
- **`plan_app_update`'s annotation.** Core declares it non-destructive and idempotent but not
  read-only, because it reaches out to the app's source. A per-tool rule covers it either way; the
  annotation stays Core's call.

## Verification

- Gateway vitest: rule store round trip and pruning; the predicate as pairs (a rule lets the exact
  tool through, its neighbour still asks; a prefix matches its command and refuses the compound
  form; a session grant dies with the session); both adapters consulting it; the audit report.
- Settings page: tool list rendered from a stubbed `tools/list`, labels from the hints, a mode change
  saved and reflected from confirmed state.
- Live, on the dev host: the H2 check above; a per-tool rule and a session grant observed to skip
  the card and to leave their audit lines.
