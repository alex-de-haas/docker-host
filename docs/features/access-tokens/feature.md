# Access Tokens — Credentials For Clients Without A Browser

Created: 2026-07-31
Updated: 2026-08-04

Core accepts a session as `Authorization: Bearer <session id>`, but a session could once only be created
by posting Core's HTML login form — which is why the Swift Shell used to sign in through a `WKWebView`
on `/login`. A client with no browser engine had no way in at all.

Two ways in now exist. A device shows a short code and someone approves it in Shell; or a credential is
created in Shell directly and its value shown once. Both produce the same thing. `hosty login` was the
first consumer, and the Swift Shell is the second — it signs in this way rather than in a web view,
because an embedded web view is where a saved password cannot be reached
([swift-shell](../swift-shell/feature.md)).

## One credential type, marked by kind

An access token is an ordinary `AuthSessionRecord` with a `Kind`, not a new credential type
([UserDirectoryStore.cs](../../../apps/core/src/Haas.Hosty.Core/UserDirectoryStore.cs)). Bearer
resolution, the sliding idle window, instant revocation and the logout cascade over app grants already
worked on that record; a separate token store would have duplicated all four.

`Kind` and `Label` are additive and nullable. A record without a kind is a browser session — which is
every record written before this shipped, so existing state loads and behaves exactly as before.

Two kinds exist, differing only in where they came from
([AuthLifetimes.cs](../../../apps/core/src/Haas.Hosty.Core/AuthLifetimes.cs)):

| Kind | Origin |
| --- | --- |
| `device` | Approved through the device authorization flow. |
| `manual` | Created in Shell, value shown once. The only source for `hosty login --token`. |

## The credential carries its approver's full role

Core has two roles and **no scopes**, so an access token can do everything the user who approved it can
do — including installing apps, reading app secrets and managing users when that user is a
`host.admin`.

This is stated wherever it matters rather than left to be discovered: the Shell surface says it, and
`hosty login` warns when the credential belongs to a non-administrator. A client that presents itself as
narrower than its credential is narrower only in its own interface, which is not an authorization
boundary. Narrowing it for real needs scopes, which do not exist yet.

`GET /api/auth/session` returns the record's `Kind` alongside the user, so a client can see what it
holds and warn its operator.

## Device authorization flow

```text
POST /api/auth/device/code     → deviceCode, userCode, verificationUri, intervalSeconds, expiresInSeconds
POST /api/auth/device/token    → pending | approved(token) | denied | expired
```

Both are unauthenticated, because the caller has no credential yet — that is the whole point. They are
the only two public routes here; approval and credential management are session-gated
([AccessTokenEndpoints.cs](../../../apps/core/src/Haas.Hosty.Core/AccessTokenEndpoints.cs)).

`verificationUri` points at Shell's own Settings route (`/settings?tab=tokens`), because Settings opens
on Users otherwise. It survives a sign-in: Shell names the page it was heading for when it sends a
visitor without a session to `/login`, and Core resolves that continuation against the Shell origin
([local-password-login](../local-password-login/feature.md)). Without both halves the operator who
follows an approval link with no browser session lands on Shell's bare origin, having lost the pending
code they came to approve — the likeliest case of all, since a device is usually enrolled from a browser
that has not signed in yet.

Pending requests live in memory only
([DeviceAuthorizationStore.cs](../../../apps/core/src/Haas.Hosty.Core/DeviceAuthorizationStore.cs)).
Durability would buy nothing: a request lives ten minutes, and a Core restart inside that window leaves
the device polling, which answers `expired` and starts over — the same recovery it already needs for a
code nobody approved.

The guards are deliberately small:

- a request expires after ten minutes;
- outstanding requests are capped **per source address, never globally**. A single global ceiling would
  be the availability hole rather than the fix: on an internet-reachable Core one caller could hold it
  full and block every legitimate enrollment while staying well inside any memory budget;
- `userCode` is eight characters from an alphabet with no `0/O`, `1/I/L`, `5/S` or `2/Z`, because it is
  read off a small screen;
- the device polls no faster than the returned interval.

An approved request is consumed on the first poll that collects it, so a replayed device code cannot
collect the credential twice. Two approvers racing one code produce one credential: the loser's is
revoked rather than left dangling.

## Lifetime

An access token has an idle window and **no absolute expiry** — `ExpiresAt` is set to the maximum so
only inactivity can end it. A credential living in a pocket or a keychain cannot stop on a fixed date
for no reason its holder can see.

The window is `HOSTY_AUTH_ACCESS_TOKEN_IDLE_HOURS`, default 90 days, editable live from Core settings
like the other lifetimes. Session pruning judges every record by its own kind's window, so a browser
login cannot prune a live access token whose window is much longer.

## Management surface

Shell's Settings gains an **Access tokens** tab
([settings-tokens-section.tsx](../../../apps/shell/src/app/shell/pages/settings-tokens-section.tsx)):
pending device requests with their label and remaining time, a create form, and the list of active
credentials with a revoke action. A `host.user` sees and manages their own; a `host.admin` sees all,
because revoking the credential on a lost device is a host-wide concern.

Settings is otherwise an administrator page, and this is the one tab on it that is not. An ordinary user
reaches Settings only for this tab, sees only this tab, and every other tab is gated on the admin check
in both the tab strip and the body — so a hand-typed `?tab=` cannot render an administration surface.
Without that, a role Core deliberately supports would have had no way to manage its own credentials.

**A listed credential never carries its own value.** A session id *is* the bearer credential, so the
listing shows a SHA-256 fingerprint and revocation matches on that — the same leak-safe projection the
user-management session list already used. The real value exists only in the response to its own
creation, or in the device's collecting poll.

Revoking takes effect at once and does three things: marks the record revoked, cascades to the app
grants it authorized, and **closes the event stream the credential currently holds open**
([CoreEventHub.cs](../../../apps/core/src/Haas.Hosty.Core/CoreEventHub.cs)). Without the third, a
revoked device would keep receiving notifications over an already-established connection for as long as
it stayed connected — which is exactly the window a lost device is revoked to close.

## CLI

```text
hosty login --host https://hosty.example                    # device flow
hosty login --host https://hosty.example --token <value>    # a credential created in Shell
hosty login --list
hosty login --use <context>
hosty logout [--name <context>]
```

The credential is proved against `/api/auth/session` before anything is stored, so a typo fails at login
rather than on the next command. Contexts — name, origin, user, and which is current — live in
`~/.hosty/config/contexts.json`; the credential never does.

**No CLI command runs against a saved context yet.** `hosty apps`, `hosty users` and the rest still open
the local control channel, which only works on the host itself; there is no global `--context` flag.
Signing in stores a working credential — usable by the Cardputer console, a script, or `curl` — but the
CLI cannot yet spend it on the user's behalf. Wiring the existing commands onto a bearer-authenticated
remote transport means mapping each one from its `/control/v1` path to its `/api` web twin at more than
ten call sites, which is its own piece of work rather than a corner of this one.

Where the credential goes depends on the platform
([CredentialStore.cs](../../../apps/cli/src/Haas.Hosty.Cli/Configuration/CredentialStore.cs)): the macOS
login keychain via `security`, and an owner-only file under the Hosty config directory everywhere else.
The file is weaker and is stated plainly rather than dressed up — on Linux the alternative is a Secret
Service session a headless box often lacks, and on Windows DPAPI would mean a package reference this AOT
binary does not otherwise need. It matches how the CLI already stores its other local secrets, and the
credential is revocable from Shell the moment it is suspect.

The CLI's trusted local control channel is untouched. It remains the bootstrap path before any user
exists and the recovery path when every credential is lost.

## Audit

Three actions, following the existing `auth.*` naming, with `ResourceType` `auth.credential` and the
fingerprint as `ResourceId`:

| Action | Actor | Details |
| --- | --- | --- |
| `auth.device.approved` | approving user | label, kind |
| `auth.device.denied` | denying user | label |
| `auth.credential.created` | creating user | label, kind |
| `auth.credential.revoked` | revoking user | label, kind |

Audit is readable through the CLI's local control channel (`/control/v1/audit/recent`); there is no
Shell surface for it.

Attributing an individual *mutation* to the credential that made it is **not** implemented. It was
planned, on the assumption that lifecycle and update mutations already wrote audit records into which a
credential label could be added. They do not: audit today covers auth and backup retention only, so
attribution would first require introducing lifecycle auditing — a different feature with its own
action taxonomy. See [Testing Expectations](#testing-expectations) for what is covered instead.

## Testing Expectations

- kind-based idle selection, including that an unknown future kind does not inherit the long window;
- an access token staying live past a browser session's absolute cap, and dying when its own idle window
  elapses;
- pruning keeping a live access token while dropping an idle-expired browser session;
- state written before this feature loading unchanged and still behaving as a browser session;
- device-code expiry, per-source cap isolation, single-collection of an approved request, and the
  approval race;
- label normalization bounding untrusted display text;
- `CloseSession` ending only the stream belonging to the revoked credential;
- over real HTTP: the full flow from no credential to a working one, that a listing never contains a
  credential's value, that another ordinary user can neither see nor revoke someone else's credential,
  and that the two public device routes are the only unauthenticated ones added.
