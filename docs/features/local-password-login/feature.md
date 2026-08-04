# Local Password Login

Created: 2026-07-06
Updated: 2026-08-04

Core owns sign-in for an installed host: an operator signs in at Core `/login` with an email and a
password, and gets the ordinary browser session every other surface already understands
([Auth And Gateway Model](../auth-gateway/feature.md)). No CLI-generated recovery token is involved in
the normal case — that path exists for break-glass only.

Shell stays a browser client that redirects an unauthenticated visitor to Core-owned `/login`, and the
native client shows the same page in a web view ([swift-shell](../swift-shell/feature.md)). Keeping the
form inside Core's page is what lets a provider Core gains later work everywhere without a client change.

In `Development` the same route is a different page: a selector over the enabled seeded users, with no
password. Production login and the development helper are separate renderers, so neither drifts into the
other.

External OIDC providers, password-reset email, multi-factor authentication, and throttle state that
survives a Core restart are all outside this feature.

## The pages Core serves itself

Five pages are Core's entire UI: `/login`, `/setup`, `/setup/invite`, `/recovery`, and the plain status
page it falls back to when a host has no Shell installed. They share one stylesheet constant in
[HostyCoreApplication.cs](../../../apps/core/src/Haas.Hosty.Core/HostyCoreApplication.cs) rather than
five near-identical copies, because a fix applied to one of five copies is a fix that shipped broken
four times.

Two properties of that markup are load-bearing:

- **The card is laid out in `border-box`.** Under the default `content-box` its padding and border are
  added to a width already sized against the viewport, so the card renders wider than the window it is
  in. Every narrow viewport — a phone, and the native client's sign-in sheet — got a horizontal
  scrollbar over a clipped form.
- **The identity field carries `autocomplete="username"`,** next to `autocomplete="current-password"`.
  That pair is what a password manager matches on before it offers a saved login; `email` is a
  contact-detail token and does not stand in for it. It is the only part of AutoFill a page can
  control — whether the browser acts on it is the browser's decision, and a `WKWebView` embedded in a
  third-party app does not.

The sign-in page itself is titled `Hosty Login` and states nothing about the deployment. Which Core
answered and where its Shell lives are facts for a signed-in operator, and `/login` is the one page
anyone who can reach the host can see; the post-login status page still reports both, because by then
there is a session and no Shell to show them in.

## Credentials

Setup, recovery, and invitation acceptance each require a password: the page collects password and
confirmation, checks the confirmation client-side, and Core validates policy server-side before creating
or restoring the user.

A password is never stored directly. Local credentials live as records separate from `HostUserRecord`,
keyed by user id, each with a per-password random salt and a PBKDF2-HMAC-SHA256 hash at 600,000
iterations (current OWASP guidance). `HostUserRecord` and every user summary API stay free of hash
material.

`LocalPasswordAuthService` owns policy validation, hashing and verification, credential upsert for the
three account-creating flows, authentication, and in-memory throttling of repeated failures — throttled
separately by email and by remote address, with a cap on the tracked keys so unique login attempts
cannot grow it without bound. The throttle resets when Core restarts.

A failed login answers one generic message. Which of email, password, or user state was wrong is never
distinguishable, so the page cannot be used to enumerate accounts. A disabled user cannot authenticate
even with a valid password.

## Accounts without a password

A user created before this feature has no password credential and cannot use `/login` until one is set
through recovery or an invitation. Nothing is migrated automatically and no temporary password is
generated — a recoverable password created on the user's behalf is worse than an explicit recovery step.
`hosty auth recovery-token` once after an upgrade is the intended path, and the login page says so.

Setup is unavailable once an enabled administrator exists; recovery remains the break-glass flow.

## Testing Expectations

- Password credential creation and successful authentication.
- Wrong password, disabled user, missing credential, and throttling behavior.
- Setup requires a password and stores only hash material; recovery sets or replaces a credential and
  revokes existing sessions; an accepted invitation produces a credential.
- The development login helper stays separate from production login.
- Core's served pages keep `border-box` layout and the `username` / `current-password` pair
  ([CorePageMarkupHttpTests.cs](../../../apps/core/tests/Haas.Hosty.Core.Tests/Http/CorePageMarkupHttpTests.cs)).
