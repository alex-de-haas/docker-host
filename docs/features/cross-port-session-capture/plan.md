---
status: Draft
created: 2026-10-05
updated: 2026-10-06
summary: Prevent captured Core browser cookies from authorizing requests replayed by an app on another port.
---

# Cross-Port Session Capture — A Captured Core Cookie Must Not Carry Core Authority

## Goal

An installed app must not be able to obtain, and then replay, a user's Core browser session. Today a
malicious app can: every `*.hosty.localhost` name resolves to `127.0.0.1`, cookies are not scoped by
port (RFC 6265), and Core's session authority is carried by a bearer-replayable cookie that the
general API path accepts with no origin binding. The result is full impersonation of the signed-in
user — administrator included — bypassing the entire app permission model. This is the "separate
investigation" that [embedded app sign-in](../embedded-app-sign-in/feature.md) and
[app embedding restrictions](../app-embedding-restrictions/plan.md) both defer to.

## Current Behavior (verified against the code on 2026-10-05)

- Core's session cookie `hosty_session` is set in `AuthEndpoints.CreateSessionAsync` with
  `HttpOnly=true`, `SameSite=Lax`, `Secure=request.IsHttps`, and **no `Domain`** (host-only). Host-only
  plus Lax means the browser attaches it to any request whose host equals the cookie host, **on any
  port** — cookies are never isolated by port.
- The CSRF token `hosty_csrf` (`GET /api/auth/csrf`) is also a cookie: `HttpOnly=false`,
  `SameSite=Lax`, host-only. It therefore leaks across ports exactly as the session cookie does.
- `CoreSessionAuthorization.ResolveSessionAsync` — the gate behind `RequireSessionAsync`,
  `RequireAdminSessionAsync` and `TryResolveSessionAsync`, i.e. the whole general API — authorizes a
  credential on liveness, non-scoped audience and an enabled user. It does **not** compare the
  request host/origin against the session's stored `BrowserOrigin`.
- `ReadSessionCredential` accepts the session id either as the `hosty_session` cookie **or** as
  `Authorization: Bearer <id>`. `IsCsrfExempt` makes the bearer form skip CSRF entirely. So a holder
  of the raw id needs no CSRF token at all.
- `BrowserOrigin` (stored at login as `scheme://host`, port included) is consulted in only two places:
  `InstallationApprovalEndpoints.BrowserActorAsync` and
  `AppIdentityService.RequireLiveAuthorizingSessionAsync`. Both compare it to `request.Scheme://
  request.Host` — a value the caller controls on a server-side replay — so neither stops a replay; they
  only stop a browser from being steered at the real Core with a mismatched Host.
- Core already knows the host/port collision exists: `InstallationApprovalEndpoints
  .HasIsolatedCookieHostAsync` refuses popup recovery on a host shared with any app endpoint, with the
  comment *"Cookies are scoped by host, not port. A server on another localhost port receives the Core
  cookie too."* That guard covers the popup authorization-code flow only — not the general API, and not
  the cookie's mere presence on the app's own inbound request.
- Browser sessions are distinguishable from non-browser ones: `CreateSessionAsync` leaves
  `Kind == null`, while access tokens and native clients (Swift Shell, Cardputer) carry a `Kind`.
  `RequireBrowserSessionAsync` already keys off `Kind is not null` and cookie presentation.

## Current-Code Recheck (2026-10-06)

The plan was restored from `stash@{0}` against main at `0882a1ba`. The capture and replay
reproduction below remains historical evidence; it has not been rerun against this baseline.
The code still accepts a live unscoped session through cookie or bearer without a separate
origin-held proof in `CoreSessionAuthorization.ResolveSessionAsync`.

Two assumptions in the original proposal need correction before implementation:

- `Kind == null` does not mean browser-only use. Swift's fresh-password confirmation passes a
  primary session as bearer, and `POST /api/apps/{appId}/launch-code` explicitly requires that
  presentation with `Kind == null` for `interactiveRenewal`. Rejecting every such bearer would
  break the proof-bound native renewal shipped by app code exchange. Native primary authority
  needs an explicit migration; retaining the same browser credential as a bearer exception
  would preserve the vulnerability.
- The shared authorization gate does not cover every session use. `/api/auth/session` resolves
  records directly, logout reads and revokes the presented ID separately, and browser approval
  and navigation paths have their own session handling. Inventory and migrate these paths too;
  adding a check to `ResolveSessionAsync` alone cannot establish complete protection.

The restored plan remains Draft. Its original alternatives and questions below are proposals,
not approved protocol decisions. App embedding restrictions remain separately On Hold.

## Reproduction (2026-10-05)

Isolated Core only (data root `/private/tmp/hosty-auth-20261005/instance`, instance
`i-13d1d4c130d84ea6b0713ed0011e9740`, port 28171), reached through recovery + password login per
`AGENTS.md`. The operator's live `~/.hosty` instance and session were never used. A throwaway HTTP
server on `127.0.0.1:18099` played the malicious app's own port; it never listened on a real Hosty
port, it only logged inbound cookies.

Browser (Chromium pane), signed into Core:

1. **Top-level navigation leak.** Navigating to
   `http://core.<instance>.hosty.localhost:18099/` sent the live `hosty_session` to the capture server.
2. **No-interaction subresource leak.** From the Shell app origin (`…:28774`), a background
   `fetch(core-host:18099, {credentials:'include'})` sent the same cookie. CORS blocked the page from
   reading the response, but the server already had the cookie — the app's server consumes it, not its
   page, so CORS is irrelevant.

Server (replaying the browser-captured id against the real Core, `GET /api/auth/users`, admin-gated):

3. `Authorization: Bearer <captured id>` → **200**, full `host.admin` user directory and app
   inventory. No CSRF token, no app permission.
4. `Cookie: hosty_session=<id>` with the app's Host header, and again with a bogus
   `Host: evil.example.com:9999` → **200** both times, confirming no origin binding.
5. `GET /api/auth/csrf` returns the token in a `Set-Cookie: hosty_csrf=…`, so a capturing app holds
   both halves of the double-submit and can forge the cookie+header form too, not only bearer.

A no-credential baseline returned 401. The same mechanism lets app A capture app B's host-only cookies
by binding B's `*.hosty.localhost` name on A's own port; only the Core case was run.

## Impact

- **Chromium:** worst case. `*.hosty.localhost` names are same-site, so the Lax cookie rides a
  background credentialed subresource request — no popup, no navigation, no user interaction. Both
  vectors reproduced above.
- **Safari:** classifies `*.hosty.localhost` subresources as cross-site (observed in the project's
  2026-10-05 probe, which sent no cookie on a framed subresource). The top-level-navigation vector
  still applies, because Lax cookies are always sent on a top-level safe GET; the same probe saw Safari
  send the Core cookie to a colliding port on a top-level load. An embedded app with `allow-popups`, or
  a standalone app tab, can perform that navigation. Not reproduced here (Chromium pane); reasoned from
  the probe and the Lax specification.
- **Firefox:** not run. By registrable-domain rules `localhost` is not a public suffix, so
  `core.hosty.localhost` and an app host share the registrable domain `hosty.localhost` and are
  expected same-site, making both the subresource and top-level vectors likely; at minimum the
  top-level vector is certain. Mark as to-verify.
- **External HTTPS origins: does not apply.** When Core and apps sit on distinct public hostnames
  (`core.example.com`, `media.example.com`), an app cannot serve `https://core.example.com:<port>/` —
  it holds neither that name's DNS nor a certificate for it — so the browser never sends Core's
  host-only cookie to the app. The attack is specific to the loopback model where every
  `*.hosty.localhost` resolves to `127.0.0.1` and any app can bind a port under any such name. A
  non-default HTTP deployment that puts several apps on one hostname differing only by port would
  reintroduce it, but that is not a shipped arrangement.
- **Severity: High.** A trust-boundary defect: any installed app gains the full authority of any user
  who opens it (administrators included), with no granted permission.

## Why Request-Origin Checks Are Not Enough

The capture happens in the browser; the *use* happens server-to-server. The malicious app's server
reads `hosty_session` from the inbound request it was handed and then crafts its own HTTP request to
Core, controlling every header — `Host`, `Origin`, `Sec-Fetch-*`. So any defense that inspects a
header on the credentialed request is defeated: the replay reproduces whatever Core wants to see. This
rules out, as a *primary* fix, a stored `BrowserOrigin` compared to `request.Host`, an `Origin`
allow-list, or `Sec-Fetch-Site` gating. The only thing a capturing app cannot reproduce is a secret it
never obtained. That is the pivot for the proposals below.

## Proposed Mitigations (directions — owner decides)

Listed strongest first. They compose; a likely answer is **1 + 2**.

1. **Proof-of-possession in origin-scoped storage (primary).** Browser (`Kind == null`) sessions stop
   being usable from the credential alone. At login Core also establishes a secret the browser can
   present and Core can verify, held where a colliding port cannot read it: `localStorage`, IndexedDB
   and WebCrypto keys are scoped by origin = scheme + host + **port**, so `…:28171` and `…:18099` have
   separate stores. Core's own first-party page writes it; Core requires it on every credentialed
   browser call. The capturing app gets the cookie but not the store, so it cannot assemble a valid
   request. Two shapes:
   - *Bearer secret:* a random PoP token written to `localStorage` by Core's page and sent in a header;
     Core stores its hash beside the session. Simple; still a secret that XSS or a log could expose.
   - *Asymmetric (DPoP-like):* a non-extractable WebCrypto key in IndexedDB signs a per-request
     challenge; Core stores the public key with the session. Stronger — nothing replayable leaks — but
     heavier and needs a nonce/timestamp to stop signature replay.
2. **Refuse cookie-only authority for a browser session (close the bearer bypass).** A session with
   `Kind == null` is rejected on the `Authorization: Bearer` path and required to carry the PoP proof
   on the cookie path. Bearer presentation stays available only to sessions that carry a `Kind` (native
   clients, access tokens), whose ids never live in a browser cookie and so do not leak this way.
   Without this, mitigation 1 is sidestepped by presenting the leaked id as bearer.
3. **Move the CSRF token out of a cookie.** `hosty_csrf` leaks across ports today and so adds nothing
   here. If a PoP secret in origin-scoped storage replaces it (or backs it), the double-submit stops
   being forgeable by a capturing app. Folding CSRF into the PoP header avoids shipping two
   browser-held secrets.
4. **Defense-in-depth, not a primary fix:** on credentialed browser calls, additionally reject a
   `request.Host` that is not Core's own browser origin, and require `Sec-Fetch-Site: same-origin`.
   Cheap and blocks the naive browser-steered variant, but, per the section above, does not stop a
   server-side replay. Only valuable alongside 1–2.
5. **Structural overlap, tracked elsewhere:** changing the origin model so two trust domains do not
   share a port-bindable host is the domain of
   [app embedding restrictions](../app-embedding-restrictions/plan.md) and
   [local browser origins](../local-browser-origins/feature.md). PoP is the session-layer fix and holds
   regardless of how origins are arranged, so it should not wait on an origin-model change.

## Open Questions

1. **PoP shape:** bearer secret (1a) or asymmetric proof (1b)? Trade simplicity against leak
   resistance. Does the threat model include XSS on Core's own origin, which would read a bearer secret
   but not a non-extractable key?
2. **Native and access-token clients:** confirm every non-browser credential carries a `Kind` so that
   refusing bearer for `Kind == null` (mitigation 2) breaks nothing. Swift Shell and Cardputer paths
   need explicit coverage.
3. **Rollout:** a browser with an old Core page and a new Core (or the reverse) must not be locked out.
   Likely a grace period where the PoP header is accepted-if-present, then required — mirroring the
   report-then-enforce option in [app code exchange](../app-code-exchange/plan.md).
4. **Scope of the requirement:** apply PoP to every credentialed browser route, or only to a
   sensitive-route set at first? A blanket requirement is simpler to reason about and avoids a
   route-classification mistake.
5. **Interaction with silent sign-in:** the silent `prompt=none` flow in
   [embedded app sign-in](../embedded-app-sign-in/feature.md) relies on the Lax cookie reaching Core's
   frame. Confirm a PoP requirement changes only how Core's *own* API is called, not how the app
   obtains its *own* code, so silent sign-in is unaffected.

## Interaction With Existing Features

- [Embedded app sign-in](../embedded-app-sign-in/feature.md) and
  [app embedding restrictions](../app-embedding-restrictions/plan.md) both name this investigation and
  defer the shared-cookie threat to it. This plan supplies the session-layer half; embedding
  restrictions supply the framing/clickjacking half. Neither blocks the other.
- [Auth session lifecycle](../auth-session-lifecycle/feature.md): a PoP requirement adds a wire
  obligation to credentialed browser calls and changes what a browser session cookie alone can do —
  its contract text needs revision.
- [Local browser origins](../local-browser-origins/feature.md): already states a shared DNS suffix is
  not proof of same-site; this adds that a shared *host* is not an authority boundary, because ports do
  not scope cookies. `HasIsolatedCookieHostAsync` and the `BrowserOrigin` binding are the partial,
  popup-only precedents to generalize.
- [App permission management](../app-permission-management/feature.md): the model this attack bypasses
  entirely. Worth a cross-reference once a fix lands.
- [Core API](../core-api/feature.md): the credentialed-route contract changes.
- Not covered by the [2026-10-02 app permissions review](../../reviews/2026-10-02-app-permissions-review.md)
  (AP-1…AP-11); this is a distinct finding.

## Deliberately Not Doing (unless a decision changes it)

- A request-header origin check as the *primary* defense (defeated by server-side replay).
- `SameSite=Strict` or dropping `Lax` on Core's cookie: it would not stop top-level-navigation capture
  and would break legitimate cross-origin entry.
- Port-scoping cookies: not expressible in the cookie model.

## Deliverables

- [ ] D1. Owner decision on the PoP shape (open question 1) and scope (open question 4); this plan moves to
  Ready only after that, per `AGENTS.md`.
- [ ] D2. Core: establish and verify the PoP secret/key for `Kind == null` sessions; require it on
  credentialed browser routes through `ResolveSessionAsync` (one gate, not per-route).
- [ ] D3. Core: refuse a `Kind == null` session on the bearer path; confirm `Kind`-bearing clients are
  unaffected, with tests for Swift Shell / Cardputer / access-token shapes.
- [ ] D4. Core: retire or re-home the cross-port-leaking `hosty_csrf` cookie per the chosen PoP shape.
- [ ] D5. Core tests: a leaked id as bearer is refused; a cookie without the PoP proof is refused; a bogus
  Host no longer matters because the proof, not the origin, is the gate; a genuine Core-origin page
  still authorizes; rollout grace mode if chosen.
- [ ] D6. SDK / Core page: write and attach the proof from Core's own origin; verify an app page on a
  colliding port cannot read it.
- [ ] D7. Rollout handling (open question 3) and the native-client confirmation (open question 2).
- [ ] D8. Live reproduction re-run against the fixed build: the colliding-port capture still yields the
  cookie (unavoidable) but the replay is refused in Chromium; the Safari top-level vector likewise;
  Firefox checked.
- [ ] D9. `feature.md` for this feature, updates to the feature docs listed above, versions bumped
  (minor platform for a Core contract change; patched SDK and in-repo apps whose bundles carry the
  changed slice), this `plan.md` deleted and the index regenerated.

- [ ] D10. Migrate Swift primary-session confirmation to authority distinct from a capturable
  browser cookie, and inventory direct session consumers outside `ResolveSessionAsync` so session
  probes, logout, browser approvals and authorization continuations enforce the chosen proof.

## Verification

Automated: `npm run core:test`, `npm run sdk:test`, plus the web apps' test suites and production
builds for any changed SDK slice.

Live acceptance uses an isolated Core-managed instance with normal setup/recovery and password login,
per `AGENTS.md`. A probe server stands in for the malicious app's own port; it never listens on a real
Hosty hostname, since cookies ignore ports and it would otherwise receive the host's real cookies. The
operator's live instance and session are never used. Acceptance asserts the replay is refused, not that
the cookie stops reaching the probe (it cannot be stopped at the browser), which is exactly why the fix
lives in what Core requires, not in what the browser sends.
