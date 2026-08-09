# AI Gateway

Created: 2026-08-09
Updated: 2026-08-09

The Hosty assistant: an optional, removable system app (`hosty.ai-gateway`) hosting admin-only
operator chat sessions on a host-resident agent harness, plus the Shell surface that renders them.
This is the operator milestone of the [AI Agent Bridge](../ai-agent-bridge/plan.md) umbrella; the
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
- Rollout caveat: a record built by a Core that predates the extension lacks the section until the
  next install/update rebuilds it (a reviewed same-version update suffices). The 2026-08-09 rollout
  hit exactly this when the app was installed before the Core update.

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
  same approval is a 409), cancel. `/healthz` is public and reports harness availability with an
  operator-facing reason. CORS reflects the request origin — auth is a header token, never a
  cookie, so a foreign page gains nothing from being allowed to send an unauthenticated request.
- Transcripts are the persisted event log: `{data}/sessions/{id}/record.json` plus append-only
  `events.ndjson` with a monotonic seq; streaming deltas are live-only. A daily sweep deletes
  sessions older than `HOSTY_AI_GATEWAY_RETENTION_DAYS` (default 30).
- Audit: the gateway reports `ai_session_created`, `ai_action_approved` (with the tool name), and
  `ai_session_cancelled` to Core's app-audit endpoint (`POST /api/internal/apps/{appId}/audit`,
  service-token-scoped; Core namespaces actions as `app.*` and caps detail size). Lifecycle and
  approvals only — transcript content never reaches Core.

## Harness

- The adapter contract is start / send / resolveApproval / interrupt / stop plus a single event
  callback; the concrete harness stays replaceable. The shipped adapter drives the Claude Agent SDK
  (pinned exactly in package.json) with streaming input, partial-message deltas, and
  `settingSources: ["user", "project"]` — an operator session behaves like the admin running Claude
  Code by hand, their instructions and skills included.
- Approval policy (v1, no exceptions): `permissionMode: "default"` with read-only tools (Read,
  Glob, Grep, WebFetch, WebSearch, TodoWrite, Task) auto-allowed; every other tool pauses inside
  `canUseTool` until the operator decides in Shell. A deny unblocks the harness with a message. A
  failed run is dropped on its error event so the next message starts a fresh run; the
  harness-native session id is captured and used to resume after a gateway restart.
- Credential: the Agent SDK does not read an interactive `claude login` — it needs an environment
  credential (`ANTHROPIC_API_KEY`, a `claude setup-token` OAuth token, or a provider
  `CLAUDE_CODE_USE_*` configuration), offered as optional secret app settings. Without one the
  health probe reports the reason and Shell shows "assistant unavailable" instead of a chat box.
- `HOSTY_AI_GATEWAY_HARNESS=fake` swaps in a deterministic in-process harness (tests and
  credential-less development).

## Shell Surface

- The panel is a right-anchored dialog: streaming deltas with a typing indicator, the transcript
  rebuilt from the event log, inline approval cards showing the proposed tool input with
  Allow/Deny (resolved ones collapse to a badge), a status chip, and a New-session reset.
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
- SDK (vitest): delegated-token validator — valid token, wrong audience, expiry, tampered payload,
  malformed shape, missing key.
- Shell: eslint + `next build` gate the surface; there are no unit tests for it, so changes are
  verified live — install the gateway, set a credential, run a chat turn, and confirm a proposed
  write pauses on an approval card and executes only after Allow.
