# AI Gateway Provider Connections

Created: 2026-09-17
Updated: 2026-09-18

## Behavior

The Gateway owns named agent connections in **Settings → Hosty AI Gateway**, in the **Providers** tab.
Administrators add, edit, test, remove and choose a default connection. Multiple connections can use
the same provider. Configuration changes require no Gateway restart. Connections are shared by the
host's administrators, consistent with the operator assistant; a connection name is not a user boundary.
Adding and editing a connection use a modal form with provider-specific fields. Errors remain inside
the form; Cancel, Escape and the close button dismiss it and clear unsaved credentials.
Each row keeps its actions in a three-dot menu: test, edit, remove, set default and ChatGPT sign-in
where applicable. Device sign-in opens a modal with a copy-code button, browser link, status and
cancellation; closing a pending modal cancels that attempt without replacing a working credential.

| Provider | Authentication | Setup |
| --- | --- | --- |
| Codex | ChatGPT sign-in | Open the supplied OpenAI browser link and enter the displayed device code. No ChatGPT app or callback to the Hosty host is needed. |
| Codex | API key | Enter an OpenAI API key; the native login receives it over stdin. |
| Codex | Existing host login | Select an absolute Codex home accessible to the OS user running Core. The native login remains operator-owned. |
| Claude | API key | Enter an Anthropic API key. |
| Claude | Claude Code token | Enter the token produced by `claude setup-token`; replace it when it expires. |

There is no custom Claude OAuth login flow. Provider type and authentication method are fixed for
an existing connection; create another connection to change them. Secret fields are write-only.
**Test** checks local adapter/credential setup, not paid inference or remote API entitlements. The
first real turn can still report an expired credential, denied model access or upstream outage.
Managed conversation directories use junctions on Windows so setup does not require symbolic-link
privileges; other hosts use directory symlinks. Recognized filesystem failures report their error
code and storage guidance without exposing paths or credentials.

ChatGPT sign-in uses the pinned Codex app-server's `account/login/start` with `chatgptDeviceCode`.
The Gateway waits for `account/login/completed`, stores the native renewable auth document in Core,
and reports success only after publishing its secret reference. Cancellation uses the native cancel
request and terminates the dedicated login process. Pending attempts expire after 15 minutes and
terminal status remains queryable for 10 minutes. A failed sign-in keeps an existing credential.

Gateway declares one `ui.settings` surface at `/settings`. It owns three internal tabs:
**Providers**, **System prompt**, and **MCP access**. The last tab includes MCP provider permissions
and changed app instructions. Switching tabs preserves unsaved form state. The existing
`/settings/providers`, `/settings/prompt`, and `/settings/access` URLs open this same tabbed page
with the corresponding initial selection. The full-workspace iframe keeps modal overlays over all
Gateway settings content, including its tabs.
MCP rows vertically center their approval dropdown and enable switch alongside the provider details.

## Chats and capabilities

A new chat takes the configured default unless its creation request names a connection. An empty
chat can explicitly select another connection; the first accepted message locks its choice. A
started chat persists connection id, credential revision, adapter kind and native session id.
Changing the default does not rebind existing chats or creation retries. Removing a connection
preserves its chat history and prevents further dispatch; there is no fallback to another provider.

Each connection has its own credential environment and native home. Parallel Claude/Codex chats
and parallel accounts of one type do not change the Gateway's global environment. Capabilities
and readiness used by a chat come from its bound provider. Aggregate health is available when any
configured connection is usable; it is not permission to substitute that connection for a chat.

Credential replacement advances the connection revision; renaming does not. Old chats cannot
resume under a replacement account. An existing host login also records a non-secret account
fingerprint in each chat; a change outside Hosty is detected before another message is dispatched.
Stop the connection's open chats before replacing credentials, signing in again or removing it.
The chat's **Stop** button releases its native process and preserves history. A send reserves its
connection until dispatch, preventing a concurrent credential edit from racing session creation.

## Storage and recovery

`connections.json` in Gateway data contains versioned connection metadata, the default, import
markers and a cleanup journal of secret references. Credentials live in Gateway's namespace in
the [Core App Secrets Store](../app-secrets-store/feature.md), under opaque `agent.<uuid>` keys.
The Gateway accesses Core with its service token; browser APIs never return credential values or
that service token. The plain Node backend implements the same internal HTTP contract as the SDK.

Managed native homes are `<cache>/agent-providers/<connection>/<revision>/`. Only the native
conversation directories are linked to durable `<data>/provider-sessions/<connection>/<revision>/`:
Codex `sessions` and `archived_sessions`, Claude `projects`. Auth/config files and pending-login
homes stay in cache. API-key auth is recreated there from Core; ChatGPT's refreshed native auth
is synchronized back to Core every five seconds, at adapter resolution and at orderly shutdown.
A synchronization error is reported and prevents further dispatch until storage works again.
A crash between native refresh and synchronization can require sign-in again.

Core's secret must exist before cached ChatGPT auth can be synchronized: missing secrets are a
reconnection requirement, never recreated from cache. Secret rotation writes a new reference before
publishing metadata. Unreferenced secrets are journaled before writes and cleanup retries after
failures. Connection deletion removes its secret before metadata and removes managed credential
copies. Native conversation directories remain with chat history. External host login directories
are never removed; directories inside Gateway's data tree are refused for that mode.

App backups contain metadata and conversation state, excluding Core secrets and cache auth files.
A same-host restore uses surviving Core secrets; restoring elsewhere requires reconnecting. Restoring
an old registry cannot resurrect a deleted secret. Core secrets currently use owner-only plaintext
files: this is backup separation, not encryption or protection against host compromise.

## Legacy configuration

At first startup with this feature, configured Claude and Codex environment credentials are imported
into connections and Core secrets. The previous harness selects the initial default. Import markers
make retries idempotent, including partial failure. Later environment changes do not override saved
connections. Legacy manifest fields remain explicitly labeled import-only compatibility inputs,
because removing them from an app update would discard Core's settings before migration can read them.
After verifying the imported connection, operators can clear their old Dashboard credential fields.

The former managed `<data>/codex-home` is retired after the replacement API-key login is usable:
conversation directories are copied to durable provider storage, and the old home is moved out of
backup scope into cache. Previous archives are not rewritten. Failed migration is reported at
startup and retried on another startup; it does not activate a hidden environment fallback.

Old chat records contain no reliable adapter provenance. Their UI requires explicit confirmation of
the original connection/account before binding and resuming. Claude adoption copies only the named
native session and its subagent directory from the operator's previous default Claude home. Codex
uses the migrated session directories or the explicitly selected host login. A missing native Codex
session produces an error instead of silently starting a replacement conversation.

## API

All routes below use the existing administrator authentication and cookie CSRF gates:

- `GET/POST /api/connections`: list metadata/readiness or create a connection.
- `PUT/DELETE /api/connections/:id`: edit or remove a connection.
- `PUT /api/connections/default`: choose `connectionId`, or `null` to clear it.
- `POST /api/connections/:id/test`: local readiness and capabilities.
- `POST /api/connections/:id/login`: start/reuse a pending ChatGPT sign-in.
- `GET/DELETE /api/provider-logins/:id`: poll/cancel sign-in.
- `PUT /api/sessions/:id/provider`: select an empty chat's connection; `confirmLegacy` explicitly
  acknowledges the account for an older unbound chat.
- `GET /api/health?sessionId=:id`: the selected chat's capabilities/readiness.

The MCP application-provider controls are separate. This feature does not implement the tool-level
Ask/Run/Disabled policy tracked in [Assistant Approval Rules](../assistant-approval-rules/plan.md).

## Verification

Acceptance checks on 2026-09-17 used the Core-managed development app and Shell embedding. Real
Claude-token, external Codex login and managed ChatGPT connections each completed a minimal turn
and resumed the same native conversation after stopping. The owner completed ChatGPT device login.
A separate copy of durable data also resumed the real Codex conversation from an empty cache, using
credentials reconstructed from the secret store. The Core-created backup contained native history
and no managed credential values or credential files. Synthetic tests cover API-key setup, token
refresh, concurrent accounts, partial failures, migration and same-/fresh-host restore behavior.

Browser checks cover the provider action menu, sign-in modal, copy confirmation and cancellation,
and the default connection and persisted provider override in an empty chat.
Gateway version: **0.29.0 → 0.30.0**; Core and SDK contracts are unchanged.

## Testing Expectations

- Windows storage setup succeeds without symlink privileges for both providers; removing cache
  preserves durable history, and recognized storage errors contain no paths or credentials.
- Test registry CRUD, idempotent import, failure between secret and metadata changes, cleanup retry,
  cancelled/failed device sign-in, native token refresh, cache loss and old/fresh-host restores.
- Assert secret absence in settings responses and backed-up data, with successful native auth as
  the positive control. Test native conversation survival independently of credential reconstruction.
- Exercise concurrent provider types and accounts, defaults/creation retries, empty-chat changes,
  started-chat locks, per-chat capabilities, restart resume, missing/removed credentials and explicit
  legacy binding. Native protocol stand-ins supplement, not replace, real-provider acceptance checks.
- Verify settings and chat selection through a Core-managed app and Shell. Real ChatGPT authorization
  requires the account owner to complete the browser step; never insert test credentials into a real
  account or expose credentials in test output.
