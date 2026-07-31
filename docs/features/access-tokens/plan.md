# Access Tokens — Credentials For Clients Without A Browser

Status: Ready
Created: 2026-07-31
Updated: 2026-07-31

## Goal

Let a client that has no browser obtain a Hosty credential: the CLI on a remote
machine, a monitoring script, an MCP connector, a Cardputer console. Today Core
offers no such path — a Host user session comes into existence only by posting
Core's HTML login form, which is why the Swift Shell signs in through a
`WKWebView` on `/login` ([swift-shell](../swift-shell/feature.md)). A client
with no browser engine has nowhere to go.

The deliverable is a device authorization flow, a credential the flow issues, a
place to manage those credentials, and `hosty login` as the first consumer.

## Why this is its own feature

It arrived as a paragraph inside the remote-CLI direction of
[`ai-agent-bridge`](../ai-agent-bridge/plan.md), where it is one prerequisite
among many. Its consumers are not: remote CLI contexts, monitoring scripts, the
future MCP connector, and [`cardputer-shell`](../cardputer-shell/plan.md) all
want the same credential, and each of them is blocked on it.

**The CLI is the first consumer, deliberately.** Exercising the flow through
`hosty login` costs a command and a keychain write; exercising it first through
firmware costs a hardware bring-up. The infrastructure should be working before
anything harder depends on it.

## Current behavior

- A Host user session is a server-side record in
  [UserDirectoryStore.cs:96](../../../apps/core/src/Haas.Hosty.Core/UserDirectoryStore.cs).
  The credential pointing at it travels as the `hosty_session` cookie or as
  `Authorization: Bearer <session id>`; the bearer form mints no new credential
  type ([auth-gateway](../auth-gateway/feature.md)).
- Lifetimes are 7-day idle and 30-day absolute, live-editable through Core
  settings ([AuthLifetimes.cs](../../../apps/core/src/Haas.Hosty.Core/AuthLifetimes.cs)).
  Revocation is immediate because every request re-reads the record.
- There are exactly two roles, `host.admin` and `host.user`, and **no scopes**:
  `host.users.manage` is an authorization action satisfied by the admin role,
  not an RBAC entry ([user-management](../user-management.md)).
- There is no token management surface in Shell.
- The CLI's trusted local channel (`control/v1`, loopback, authorized by
  possession of the local discovery file) stays exactly as it is. It is the
  bootstrap path before any user exists and the recovery path when every
  credential is lost, and this feature does not touch it.

## Target behavior

A diff against [`auth-gateway`](../auth-gateway/feature.md).

### One credential type, marked by kind

`AuthSessionRecord` gains three nullable fields — `Kind`, `Label`, and
`ApprovedBy` — added the way `LastSeenAt` was, so existing persisted state
loads unchanged. A record with no kind is a browser session, exactly as today.

Everything downstream stays where it is: bearer resolution, the idle slide,
instant revocation, and the logout cascade over app grants already work on this
record and keep working. A separate token store would have duplicated all four.

The one behavior that reads `Kind` is lifetime selection.

### Device authorization flow

```text
POST /api/auth/device/code     → device_code, user_code, verification_uri, interval, expires_in
POST /api/auth/device/token    → pending | approved(session id) | denied | expired
```

`/device/code` is necessarily unauthenticated, which is worth two cheap
precautions and not a subsystem:

- a pending code expires in ten minutes, and outstanding codes are capped **per
  source address**, never globally. A single global cap would be the
  availability hole rather than the fix: on an internet-reachable Core, one
  caller could hold it full and block every legitimate enrollment while staying
  well inside any memory budget;
- `user_code` is short and free of ambiguous characters, and long enough that
  guessing one before it expires is not a strategy.

The device polls `/device/token` no faster than the returned `interval`. Shell
shows each pending request with its label and age, and approval is a deliberate
action rather than a consequence of opening the page — enough for an operator
to notice a request that is not theirs. Approval creates a session record of
kind `device` bound to the approving user; denial and expiry are distinct
answers and leave no record behind.

### The token inherits its approver's role, in full

**Scopes are deliberately not part of this feature.** Core has none today, and
adding them means auditing every endpoint — worth doing, not worth blocking
this on.

The consequence is written here so no consumer has to infer it: **a device
token is exactly as powerful as the user who approved it.** A token approved by
a `host.admin` can do everything an administrator can do, including installing
and removing apps, reading app secrets, and managing users. A client that
presents itself as narrower than that is narrower only in its own interface,
which is not an authorization boundary. Any consumer documenting a narrower
promise is documenting a false one until scopes exist.

Clients that need to know what they hold read `/api/auth/session`, which
already returns the user record with its role — no new endpoint is needed to
warn an operator that they authorized as `host.user` when the client wanted an
administrator.

### Lifetime

A `device` record has an idle window and **no absolute expiry**: it stays valid
while it is being used and dies when it is not. A credential meant to live in a
pocket or a keychain cannot be one that stops on a fixed date for no reason the
holder can see.

The window joins the existing values in `AuthLifetimes` and Core settings, so
it is live-editable like the others. Default: 90 days idle.

### Management surface

A Shell page listing every non-browser credential with label, kind, approving
user, creation time, last-seen time, and a revoke action — reachable in one
step, because revocation is the whole answer to a lost device or a leaked
token. Revoking ends the credential immediately, including any event stream it
currently holds open: an established SSE connection that outlives its
credential would keep delivering to whoever holds the device.

The same page **creates** a credential directly: a label, and the value shown
once at creation and never again. This is the only source for
`hosty login --token`, and it is also the path for a client that cannot run the
device flow at all — a script in CI, a container without a console. A created
credential is identical to an approved one in every other respect: same record,
same kind discriminator, same lifetime, same revocation.

A `host.user` sees, creates and manages their own credentials; a `host.admin`
sees all of them.

### CLI

```text
hosty login --host https://hosty.example   # device flow, token stored in the OS keychain
hosty login --token <value>                # headless fallback for a credential created in Shell
hosty --context prod apps list
```

Remote calls go to Core's existing web API with `Authorization: Bearer`,
alongside cookie auth. Contexts are named and stored locally; the credential
itself lives in the OS keychain, never in a config file.

### Audit

`AuditRecord` already carries `Action`, `ResourceType`, `ResourceId`,
`Outcome`, `ActorUserId`, `CreatedAt`, and a free-form `Details` dictionary
([AuditStore.cs:42](../../../apps/core/src/Haas.Hosty.Core/AuditStore.cs)), and
existing actions are named `auth.user.updated`, `auth.invitation.revoked` and
so on. Three new actions follow that shape, with `ResourceType`
`auth.credential` and the credential id as `ResourceId`:

| Action | Actor | Details |
| --- | --- | --- |
| `auth.device.approved` | approving user | label, kind |
| `auth.device.denied` | denying user | label |
| `auth.credential.revoked` | revoking user | label, kind |

**The harder half is telling a console apart from a browser.** `ActorUserId` is
a *user*, and a device credential belongs to a user, so on its own the trail
cannot distinguish "Alex from the browser" from "Alex's Cardputer" — which is
precisely the question worth answering when an app restarts at three in the
morning.

The answer is the `Details` dictionary that already exists: a mutation made
with a non-browser credential records its label there. No schema change, no
migration, no new field.

Scope is bounded on purpose. Audit appends live at many call sites across Core,
and threading a credential through all of them is exactly the kind of sweep
that turns a small feature into a long one. This adds it only to the actions a
non-browser client actually performs — app lifecycle, app update, Core restart
and update — where the question gets asked. The rest keep recording the user
alone, as they do today.

Worth knowing when judging how much this is worth: audit is currently readable
only through the CLI's local control channel
(`/control/v1/audit/recent`); there is no Shell surface for it, and this
feature does not add one.

## Deliverables

- [ ] Extend `AuthSessionRecord` with `Kind`, `Label`, and `ApprovedBy` as
  additive nullable fields, and confirm existing persisted state loads
  unchanged.
- [ ] Add the idle-only `device` lifetime to `AuthLifetimes` and Core settings.
- [ ] Implement `/api/auth/device/code` and `/api/auth/device/token` with code
  expiry, a per-source cap on outstanding codes, a poll interval, and distinct
  pending/approved/denied/expired answers.
- [ ] Add the Shell approval surface, showing label and age, and requiring a
  deliberate approval action.
- [ ] Add the Shell credential list with label, kind, approver, created,
  last-seen, and revoke, plus direct creation showing the value once, scoped to
  own credentials for `host.user` and to all for `host.admin`.
- [ ] Make revocation terminate an in-flight event stream, not only the next
  request.
- [ ] Add `auth.device.approved`, `auth.device.denied`, and
  `auth.credential.revoked` audit records, and put the credential label into
  `Details` on app lifecycle, app update, and Core restart/update mutations
  made with a non-browser credential.
- [ ] Implement `hosty login --host`, `hosty login --token`, and context
  storage with the credential in the OS keychain.
- [ ] Document the flow in [`auth-gateway`](../auth-gateway/feature.md),
  including the plain statement that a device credential carries its approver's
  full role.
- [ ] Create `feature.md` from shipped behavior, delete this plan, and
  regenerate the documentation index in the release PR.

## Phases

### Phase 1 — Credential and flow

Record fields, lifetime, both endpoints, revocation semantics. Exercised end to
end with `curl` before any UI exists.

### Phase 2 — Surfaces

Shell approval and credential list, `hosty login` with contexts and keychain
storage, audit records.

Both phases ship in one PR under the platform version. Consumers —
[`cardputer-shell`](../cardputer-shell/plan.md), the MCP connector — are
separate features with their own PRs and do not ride along.

## Decisions recorded 2026-07-31

- **One feature for all non-browser credentials**, not a device-specific one:
  the mechanics are identical and splitting them would mean writing the second
  half on top of the first.
- **Extend the session record rather than add a token store**, because bearer
  resolution, the idle slide, revocation, and the logout cascade already exist
  on it.
- **No scopes.** Deferred whole, with the consequence stated in the target
  behavior rather than left for a reader to discover.
- **Idle-only lifetime for device credentials**, no absolute expiry and no
  refresh token — a second credential to solve a problem that sliding already
  solves.
- **Any role may enroll a device**, and the credential inherits that role. A
  client that needs an administrator says so in its own interface.

## Verification

- unit tests for kind-based lifetime selection, idle sliding without an
  absolute cap, code expiry, and the pending/approved/denied/expired
  transitions;
- a test that one source saturating its outstanding-code cap does not prevent
  another source from starting an enrollment;
- a test that a directly created credential authenticates identically to an
  approved one, and that its value is not retrievable after creation;
- a test that a mutation made with a device credential records its label in the
  audit `Details`, and one made from a browser does not;
- a test that persisted state written before the new fields loads unchanged and
  keeps behaving as a browser session;
- a test that revocation terminates an open event stream;
- a test that a `host.user` cannot see or revoke another user's credentials;
- CLI tests for `login --host`, `login --token`, and context selection;
- manual end-to-end: enroll from the CLI on a second machine, approve in Shell,
  run a command, revoke, confirm the next command fails and an open stream
  closes.

The implementation PR records exact commands and results, and runs the Core
build and tests, the CLI tests, and `node scripts/docs-index.mjs --check`.
