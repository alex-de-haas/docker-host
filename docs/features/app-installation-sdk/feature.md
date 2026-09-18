# App Installation SDK And Core Confirmation

Created: 2026-09-18
Updated: 2026-09-18

## Installation Ownership

Marketplace and Shell mount the same `InstallDialog` from `@hosty-sdk/app/install/react`.
Marketplace supplies a feed source; Shell accepts a manifest, directory or URL. Neither uses a
Marketplace-to-Shell installation message. The dialog prepares settings and a runtime selection;
final authorization belongs to a separate Core-origin page.

The SDK provides three independent entry points:

- `/install`: typed request client and `InstallationFlow` for custom UIs, without React/Next.js.
- `/install/react`: `useInstallation` and the self-contained accessible native-dialog component.
- `/install/server`: an app-local route adapter forwarding only installation request operations,
  with separate app service and user identity credentials and same-origin mutation checks.

The server adapter accepts an explicit trusted `publicOrigin` for frameworks that expose an
internal request URL. Marketplace supplies Core's `HOSTY_PUBLIC_ORIGIN_HTTP`; forwarded-host
headers do not authorize browser requests.

Core exposes create, submit and status operations under `/api/installations` for authenticated
operator clients, and `/api/internal/apps/{appId}/installations` for delegated app callers.
The app transport requires a currently enabled administrator and the installed app's approved
permission. Shell retains its existing full Core browser-session transport; this is operator
access, not an app-ID permission exemption. The remaining Shell-specific CORS policy for that
legacy management transport is unchanged. Custom app clients use the SDK server adapter.

## Manifest Permissions

`corePermissions` is an optional array in `app.0.1`. The initial vocabulary is:

| Permission | App-delegated authority |
| --- | --- |
| `apps.install` | Prepare installation requests and submit them for Core confirmation |
| `apps.update` | Submit an existing reviewed update plan for Core confirmation |

Unknown and duplicate entries fail manifest validation. These are distinct from lifecycle UI
`capabilities`, platform `provides` slots, and external-client OAuth/MCP scopes.

Core records the approved set as `GrantedCorePermissions` on installation and reviewed update.
Live-source projection, restart, runtime switching and manifest backfill preserve that stored
set; editing a source manifest does not grant new permissions. Update plans include additions and
removals. The queued update path, including MCP callers, refuses additions with `approval_required`.
After accepting confirmation, Core applies the reviewed update in the background. Explicit local control-secret
operations remain trusted operator operations.

Live-source apps can review an explicit manifest path to approve permission changes. These plans
survive list reads and fleet checks without becoming automatic update offers. A source change
between review and apply invalidates the plan.

## Trusted Confirmation

A request starts as `draft`. Submit freezes settings and autostart, then changes it to `pending`.
The SDK opens `/install/confirm/{id}` in a top-level window; a visible link is available when a
popup is blocked. The page displays the target, version, source, requester and Core permissions.
Permission additions are marked on updates. Direct host-command installs carry a warning.

After Core accepts either decision, the response attempts to close the confirmation window.
Approved work continues on Core's application lifetime token, and the requesting app polls for
completion or failure. The final page retains a readable result for manually opened tabs that the
browser refuses to close. Its CSP permits only the fixed closing script by content hash; the review
page does not enable scripts, and closing does not reconnect the app to Core through `window.opener`.

The decision requires the requesting user's current administrator browser session, a nonce issued
only to this Core page and bound to that session, and a same-origin form submission. App tokens,
full-role bearer tokens and the ordinary CSRF token do not authorize this decision. The page
refuses framing, disables CORS and uses a restrictive CSP. App-authored strings are HTML-encoded.
An approval atomically claims exactly one execution; denial, expiration and failure cannot be
replayed. The request store is bounded to 64 entries, expires pending requests after 15 minutes,
and is cleared by a Core restart. Status responses expose neither secret settings nor decision
nonces. Approval events are recorded in the audit log.

Installations consume the cached manifest selection, including feed-selected content. Changes to
the source after review do not alter the approved installation. Legacy `/api/apps/install` and
`/api/apps/install/feed` apply routes refuse direct execution with `approval_required`.

## Browser Cookie Boundary And Migration

Cookies are scoped to a hostname, not a port. Confirmation therefore refuses to operate on a
hostname also used by any registered public app endpoint or its configured public origin.
The Core browser session must have been issued on the exact confirmation origin; legacy sessions
need a fresh login. Core login preserves the confirmation continuation without requiring Shell.

Use a dedicated Core hostname. For the existing Shell cookie transport, Core and Shell also need
to remain same-site because the Core cookie uses `SameSite=Lax`; distinct sibling hostnames under
one site satisfy both requirements. Merely moving Core to another port does not. The new
Marketplace server transport has no dependency on cross-origin Core cookies.

New trusted distribution installs record their declared permissions. Existing Marketplace/Shell
installations acquire declarations through a reviewed update, without silent ID-based grants.
The operator can approve that initial update through the browser Core-session request path or
apply it through the existing trusted CLI control plane. Changing public origins and deploying
new binaries to a running host are operational migration steps, not implicit SDK behavior.

This protects the app-token API boundary. Full operator credentials and localCommand processes
running as Core's OS account are separate trust boundaries; it is not an OS sandbox.

## Testing Expectations

- Test real HTTP decisions, separate app/user credentials, rejected cross-origin decisions,
  framing headers, nonce secrecy, ownership, expiration and single-use behavior.
- Test frozen manifest execution and persisted grants, including source changes during approval.
- Test permission additions on updates and that source adoption cannot silently grant rights.
- Test client races, duplicate submits, lost responses, API errors and the server adapter boundary.
- Build and test Core, SDK, Shell and Marketplace; check package exports and artifact versions.
- Complete the remaining managed-runtime/browser verification in [plan.md](plan.md), including
  standalone Marketplace, embedding without an installation responder, and cookie-host isolation.
