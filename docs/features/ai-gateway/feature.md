# AI Gateway

Created: 2026-08-09
Updated: 2026-08-15

The Hosty assistant: an optional, removable system app (`hosty.ai-gateway`) hosting admin-only
operator chat sessions on a host-resident agent harness, plus the Shell surface that renders them.
This is the operator milestone of the [AI Agent Bridge](../ai-agent-bridge/feature.md) umbrella; the
decisions recorded there (execution profiles, placement, token mechanics, approval policy) govern
this feature.

## Discovery And Gating

- `app.0.1` manifests may declare a top-level `interfaces` map (draft extension): interface name →
  declarations `{key, endpoint, path}`. Validation is shape-only and mirrors `provides` — kebab
  names, keys unique within an interface ("default" when omitted), absolute paths — and unknown
  interface names are inert and forward-compatible. Declarations are normalized onto the app record
  at install/update and projected onto `AppSummary` with each declaration resolved to a
  ready-to-call URL from the app's endpoints.
- Shell renders the assistant surface — the sidebar launcher (Host section), the chat panel, and
  "Ask assistant" in the app details dialog — only for a `host.admin` viewer and only when an
  installed app declares `ai-gateway` with a resolved URL. No provider or a non-admin viewer means
  the feature leaves no trace in the UI.
- A record built by a Core that predates the extension lacks the section, which is what the
  2026-08-09 rollout hit when the app was installed before the Core update. Since Core 0.74.1 the
  boot-time [manifest projection backfill](../manifest-projection-backfill/feature.md) re-projects
  such records from the reviewed manifest copy automatically; no operator action is needed.

## Delegated Tokens

- `POST /api/apps/{appId}/delegated-token` trades the caller's Core session (CSRF-gated) for a
  short-TTL signed token with audience = that app. Every issue re-runs the full identity access
  policy (disabled user, system-app-admin, assignment), so revocation propagates within one TTL;
  refresh is simply calling again. Format: `hosty_delegated.1.<claims>.<sig>` — ECDSA P-256 over
  the token prefix, claims `sub`/`role`/`aud`/`iat`/`exp`/`jti`, 5-minute TTL.
- The signing key (`{AuthRoot}/delegated-token-signing.key`) is durable across Core restarts; the
  public half is injected into every app environment (docker and localCommand) as
  `HOSTY_DELEGATED_TOKEN_PUBLIC_KEY`, so receiving apps validate locally — Core stays out of the
  data path. The TS SDK ships the validator as `@hosty-sdk/app/delegated`
  (`validateDelegatedToken`, re-exported from `./server`), importable from plain Node services.

## Gateway App

- `apps/ai-gateway`: headless Node/TypeScript system app, single localCommand runtime profile
  ("local") — it spawns harness processes on the host, so it never runs in a container. Distributed
  with `defaultEnabled: false`: the assistant is opt-in and removable. Port comes from
  `HOSTY_PORT_HTTP`, data lives in `HOSTY_APP_DATA_DIR`, harness sessions start in the operator's
  home (`HOSTY_AI_GATEWAY_WORKDIR` overrides).
- Session API, admin delegated token required on every `/api` route: create session (optional
  `title` and structured `context`), list, get, `GET .../events` (SSE with an `?after=<seq>`
  reattach cursor; the connection ends at the token's expiry and the client reconnects with a
  freshly issued token), post message, resolve approval (`allow`/`deny`; a second decision on the
  same approval is a 409), answer a question (`answers` keyed by question text; a second answer is a
  409), read and write settings, cancel. `/healthz` is public and reports harness availability with an
  operator-facing reason. CORS reflects the request origin — auth is a header token, never a
  cookie, so a foreign page gains nothing from being allowed to send an unauthenticated request.
- Transcripts are the persisted event log: `{data}/sessions/{id}/record.json` plus append-only
  `events.ndjson` with a monotonic seq; streaming deltas are live-only. A daily sweep deletes
  sessions older than `HOSTY_AI_GATEWAY_RETENTION_DAYS` (default 30).
- Display: the manifest declares `catalogMetadata.icon` (`assets/icon.svg`) — a sparkle matching the
  glyph the Shell assistant surface uses, drawn in the same style as the other first-party icons.
  One declaration serves both surfaces: Core resolves it to its asset endpoint for Shell's app rows
  and detail dialog, and the marketplace catalog vendors it at publish time, so the catalog entry
  stays a pointer instead of carrying a copy.
- Audit: the gateway reports `ai_session_created`, `ai_action_approved` (with the tool name), and
  `ai_session_cancelled` to Core's app-audit endpoint (`POST /api/internal/apps/{appId}/audit`,
  service-token-scoped; Core namespaces actions as `app.*` and caps detail size). Lifecycle and
  approvals only — transcript content never reaches Core.

## Settings Surface

- The manifest declares a `ui` block, so the gateway appears as its own **sidebar section** the way
  `hosty.marketplace` and `hosty.telemetry` do — those get their navigation entries purely from
  `ui.navigation`. Pages are served from the same Node process; nothing is split out (telemetry only
  split because its backend is .NET).
- Why here and not in Shell: the assistant is optional, removable and replaceable, so a settings
  page baked into Shell would make Shell know one provider's configuration schema. Observability was
  moved out of Shell into its own app for the same reason. The page is hand-written HTML — it is two
  controls and a list, and a build step would be the largest thing in a headless Node app.
- The page shell is served unauthenticated because it holds no data: everything it renders comes
  from `/api/settings`, admin-gated like every other `/api` route, reached with a delegated token
  the embedder supplies. That is the same posture the chat panel already has.
- **System prompt.** Operator text appended to the harness's own instruction sources, capped at 8000
  characters. It applies to the **next session**, not the running one: the prompt is a session's
  instruction set, and swapping it mid-conversation would leave a transcript whose halves ran under
  different instructions.
- **MCP providers.** Installed apps declaring an `mcp` interface, read from Core's app-directory
  roster (see [app-mcp](../app-mcp/feature.md)) and refreshed on every settings read, each with a
  toggle. An unreachable Core is reported as such rather than as an empty list — the two are
  different facts, and conflating them would tell the operator their apps had vanished. **New apps
  default to off.** Tool names and descriptions are third-party text landing in the context of a
  model that holds host shell, so reaching an app is a decision, not a side effect of installing it.
  Toggles for uninstalled apps are pruned, so an uninstall/reinstall cycle cannot resurrect one.
- **Where state lives:** Core stays the registry (which apps exist, which declare `mcp`, at what
  URL); the gateway owns the policy (which are enabled). Toggles never go into Core. Settings live
  in `{data}/settings.json`, written temp-then-rename so a crash mid-write cannot leave a truncated
  file that the next start reads as "everything disabled, prompt gone".

## Harness

The adapter contract is start / send / resolveApproval / resolveQuestion / interrupt / stop plus a
single event callback; the concrete harness stays replaceable, and the operator picks one with the
`HOSTY_AI_GATEWAY_HARNESS` setting (`claude` | `codex`; an unrecognized value falls back to
`claude` rather than taking the assistant down on a typo, and `fake` is a test-only in-process
harness that is not offered as an operator choice). Each harness is pinned as a dependency and
needs its own credential; the health probe names the selected harness and, when it is unusable,
the reason. Approval policy is identical across harnesses: every write pauses, with no exceptions
and no session-scoped blanket approvals. A failed run is dropped on its error event so the next
message starts a fresh one, and the harness-native session id is captured for resume after a
gateway restart.

### Claude (default)

- Drives the Claude Agent SDK with streaming input, partial-message deltas, and
  `settingSources: ["user", "project"]` — an operator session behaves like the admin running Claude
  Code by hand, their instructions and skills included.
- `permissionMode: "default"` with read-only tools (Read, Glob, Grep, WebFetch, WebSearch,
  TodoWrite, Task) auto-allowed; every other tool pauses inside `canUseTool` until the operator
  decides in Shell. A deny unblocks the harness with a message.
- Credential: the Agent SDK does not read an interactive `claude login` — it needs an environment
  credential (`ANTHROPIC_API_KEY`, a `claude setup-token` OAuth token, or a provider
  `CLAUDE_CODE_USE_*` configuration), offered as optional secret app settings.
- The system prompt names its preset explicitly (`{type: "preset", preset: "claude_code"}`) rather
  than relying on the SDK default, because the operator profile is defined as behaving like the
  admin running Claude Code by hand — that is the Claude Code prompt, and leaving it to a default
  would make the behavior depend on an SDK decision Hosty does not control. The operator's own text
  rides in `append`, so it never displaces the preset or the user/project sources.

#### Questions

- `AskUserQuestion` is a **third branch** alongside auto-allow and the approval card: it is neither
  auto-allowed nor approval-gated. Approving the act of being asked a question is nonsense, and it
  is what the shipped version did — the operator saw "Approve AskUserQuestion?", allowed it, and the
  tool then ran with no answers and reported that the questions were not answered, at which point
  the model fell back to asking for the request in prose.
- The answer travels back as `updatedInput.answers` on an **allow**, keyed by question text, so the
  tool runs and returns the answers to the model as an ordinary tool result. This is the SDK's
  designed path: `AskUserQuestionInput` carries an optional `answers` map documented as "User
  answers collected by the permission component". Returning the answer through a `deny` message
  would risk the model reading it as a refusal and reproducing the same loop.
- A malformed ask — no questions, or a question with no options — is declined with an explanation
  rather than parked, because a card the panel cannot draw is a pause nobody can resolve.
- The `tool_use` event for an ask is suppressed: the question card is already its transcript record,
  and the raw block would render the same options a second time as JSON.

### Codex

- Drives `codex app-server` over stdio JSON-RPC. Approvals arrive as *blocking server→client
  requests* (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`) and the
  action waits for the reply, which is the same pause `canUseTool` provides. Assistant text streams
  as `item/agentMessage/delta`; `thread/start` yields the id that `thread/resume` restores, and it
  works across process restarts. (The older "Codex cannot pause per tool call" limitation is true
  of `codex exec` only.)
- Credential — **two modes, the administrator picks**:
  - *API key* (`CODEX_API_KEY` app setting): the gateway signs Codex in on the operator's behalf.
    A key set **only as an environment variable authenticates nothing** — verified against a clean
    `CODEX_HOME`, where neither `OPENAI_API_KEY` nor `CODEX_API_KEY` produced a session; Codex
    accepts a key exclusively through `codex login --with-api-key`, which reads it from stdin and
    writes it into the credential store. The gateway therefore runs that login itself, passing the
    key over stdin — never argv, where process listings would expose it. An API key does not
    expire, which is what a long-running service wants.
  - *Interactive* (no key set): someone runs `codex login` on the host **as the user Core runs as**
    — credentials are per-user, so signing in as a different account leaves the harness
    unauthenticated. The optional `CODEX_HOME` setting points at a non-default credential
    directory; the login must then carry the same directory (`CODEX_HOME=<path> codex login`),
    which the health reason spells out with the configured path filled in.
- The API-key mode writes into **its own Codex home** under the app data directory, so choosing it
  never overwrites the operator's personal `~/.codex` session (verified live: after the gateway
  signed in with a key, `codex login status` on the host still reported the operator's own
  session). A SHA-256 fingerprint of the key is stored beside those credentials, so rotating the
  key in app settings re-authenticates on the next health check; the fingerprint is written only
  after a successful login, so a bad key retries instead of sticking.
- The binary resolves override → the pinned `@openai/codex` dependency → PATH.
- **No questions.** Codex has `item/tool/requestUserInput` in the same server→client request family
  as its approval methods, but it is gated behind `tools.experimental_request_user_input` — off by
  default — and its payload shape is only inferable from the binary's serde symbols. Implementing a
  guessed shape is how this adapter has been caught twice: a reply Codex cannot act on is
  indistinguishable from one it never received. The capability flag reports `questions: false`, and
  the generic empty reply to unimplemented server requests is safe here because the binary carries
  "failed to deserialize ToolRequestUserInputResponse" — a wrong reply fails loudly.
- The operator system prompt rides in once as a header on the first message, since the protocol
  exposes no per-session instruction channel; Codex's own instruction sources are untouched.
- Three protocol properties are load-bearing and easy to get wrong, so they are pinned in
  `codex-protocol.ts` and enforced by a scripted test fake that fails the suite on a violation:
  - **The sandbox is what creates the approval.** Codex asks only when an action must escalate out
    of its sandbox, so the thread runs `read-only`; with `danger-full-access` there is nothing to
    escalate past and writes execute silently (a live run denied three approvals and the file was
    created anyway). An approved action then runs outside the sandbox.
  - **Two decision vocabularies, chosen per method.** v2 `item/*` approvals take
    `accept` | `decline` | `cancel`; the legacy `execCommandApproval` / `applyPatchApproval` take
    `approved` | `{denied: {rejection}}`. A v1-shaped reply to a v2 method is accepted at the wire
    level and then silently does nothing — indistinguishable from a denial, so it is only caught by
    checking that an *allow* actually performed the action. Session-scoped variants
    (`acceptForSession`, `approved_for_session`) are never sent.
  - **A refused item still completes.** Codex emits `item/completed` for an item whose approval was
    refused, so the adapter tracks the approval's `itemId` and suppresses the tool-use event;
    otherwise the transcript would report a denied command as executed.
- Sandbox vocabulary is asymmetric between endpoints: `thread/start` takes `sandbox` as a plain
  string (`"read-only"`), `turn/start` takes `sandboxPolicy` as an internally tagged object
  (`{type: "readOnly"}`). Swapping them is a `-32600`.
- After a denial Codex tries a different mechanism rather than stopping (patch, then shell), so
  each attempt raises its own approval card. `decline` is used rather than `cancel` so the agent
  finishes its turn and explains; Cancel in Shell is the hard stop.

## Shell Surface

- The panel is a right-anchored dialog: streaming deltas with a typing indicator, the transcript
  rebuilt from the event log, inline approval cards showing the proposed tool input with
  Allow/Deny (resolved ones collapse to a badge), a status chip, and a New-session reset.
- **Question cards** are deliberately styled apart from approval cards — options with labels and
  descriptions, single or multi select, and a free-text "other" (part of the tool contract: the
  model is told an Other option is supplied automatically, so it never lists one). An approval asks
  the operator to authorize something the agent wants to do; a question asks them to decide
  something the agent cannot. Making them look alike would train the reflex an approval gate must
  not build. Answered cards collapse to the chosen values, and a pending one rebuilds from the event
  log on reconnect exactly as a pending approval does.
- Closing the panel only drops the SSE connection — the harness run keeps working. Reopening
  reattaches by the kept session id and the stream replay rebuilds pending approval cards.
  Contextual entries ("Ask assistant" on an app's details) always start a fresh session seeded with
  `{app, page}`: stored structured on the record, and prefixed once as a plain header line on the
  first message — the prompt itself stays free-form.

## Testing Expectations

- Core: manifest `interfaces` validation (names, keys, paths, forward-compat), `AppSummary`
  interface URL projection, delegated-token unit + HTTP suites (issue policy incl. system-app-admin
  and assignment denial, local validation twin, expiry/tamper/audience), app-audit HTTP suite
  (service-token scoping, `app.*` namespacing, action shape, caps).
- Gateway (vitest): admin gate, CORS preflight, a full message turn, approval allow and deny,
  SSE replay cursor, token-expiry stream close, failed-run recovery, retention sweep; `tsc` clean.
- Questions, end to end: the round trip, a 409 on a second answer, replay of a pending question to a
  reconnecting client, cancellation resolving one, and the reported capability flags.
- Questions, at the adapter: the Claude branch is tested against a stand-in for the SDK, pinning that
  the answer comes back as `{behavior: "allow", updatedInput: {...input, answers}}` — a deny carrying
  the answer would pass every UI-level check and still reproduce the original loop. The
  malformed-ask decline and the "non-question writes still pause" branch order are covered too.
- Settings: defaults (empty prompt, every provider off), round trip surviving a restart, rejection
  of malformed writes without storing them, pruning of toggles for uninstalled apps, the admin gate,
  and the unauthenticated page shell.
- Codex adapter (vitest, against `test/fake-codex-server.mjs`): handshake, resume, streaming,
  approval allow and deny, suppression of a refused item's tool-use, process death, missing binary,
  harness selection, and binary resolution. The fake fails the suite on a protocol violation —
  wrong sandbox shape, the v1 decision vocabulary on a v2 method, or a session-scoped approval.
- An approval change is never verified by denying alone: a gate that rejects everything looks
  identical to one that is silently ineffective. Confirm live that a denial leaves nothing behind
  **and** that an approval performs the action. The same rule governs questions, and it is sharper
  there: a card that renders, is answered, and closes looks identical whether or not the model ever
  received the answer. The assertion that counts is that the agent continued **along the chosen
  option** — verified in the unit suite by breaking the answer path on purpose and confirming the
  test goes red.
- SDK (vitest): delegated-token validator — valid token, wrong audience, expiry, tampered payload,
  malformed shape, missing key.
- Shell: eslint + `next build` gate the surface; there are no unit tests for it, so changes are
  verified live — install the gateway, set a credential, run a chat turn, and confirm a proposed
  write pauses on an approval card and executes only after Allow.
- Display assets have no automated coverage: a changed icon is checked by rendering it and looking
  at it at both card and sidebar size, and by confirming the manifest path resolves.
