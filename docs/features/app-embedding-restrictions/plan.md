---
status: On Hold
created: 2026-10-05
updated: 2026-10-06
summary: Restrict app framing to operator-designated embedders while preserving the assistant browser runner.
---

# App Embedding Restrictions — Only Operator-Designated Embedders May Frame An App

## Why On Hold (owner decision, 2026-10-05)

The owner deferred this work so that it can be designed together with the assistant's host-managed
browser runner (Playwright or similar). That runner is planned in the On Hold
[app sandbox runtimes](../app-sandbox-runtimes/plan.md) plan. The restriction must not block the
assistant from opening apps and checking its own changes through Core and Shell. Resume when that
runner is designed, or earlier if the owner decides to.

## Problem

Any web page can show an app inside an iframe. A page on a foreign site gains nothing from this: it
cannot obtain the user's Core session there. An installed app, however, lives on the same site as
Core and Shell. It could frame another app that is already signed in, through
[silent sign-in](../embedded-app-sign-in/feature.md) or the app's `sessionStorage` grant within Shell's
tab, and overlay invisible controls so that the user clicks something they did not intend
(clickjacking). Without silent sign-in the same attack needs the user to press the app's sign-in
button first.

## Proposed Target

- **Designated embedders.** An app declares in its manifest that it embeds other apps, for example
  as a UI client. The operator approves the declaration, as with permissions. Shell, a third-party
  Shell or any other client the operator accepts can be an embedder. An ordinary app cannot.
- **Distributed list.** Core gives every app the current browser origins of the designated
  embedders. As with other browser origins, a change applies when the app next restarts.
- **Browser enforcement.** The SDK sends `Content-Security-Policy: frame-ancestors 'self' <embedder
  origins>` on app documents. The browser compares the real origin of every ancestor page, port
  included, with this list. Iframe attributes copied from Shell do not help a page that is not on it.
  A chain such as Shell → undesignated app → target is refused, because one ancestor is not listed.
- **Trust stays with the operator.** An embedder the operator designates can frame apps. That is the
  same decision the operator makes when granting any other permission.

## Interaction With Existing Features

- [Embedded app sign-in](../embedded-app-sign-in/feature.md) ships without this restriction and records the
  deferred risk.
- [App sandbox runtimes](../app-sandbox-runtimes/plan.md): a browser runner that opens apps top-level
  is unaffected, because `frame-ancestors` applies only to framed documents. A runner that frames apps
  in its own page must use a designated embedder's origin or go through Shell. Acceptance evidence
  must not rely on disabling CSP in the runner.
- A separate investigation is tracking the finding that a process on another port of a Core or app
  hostname receives that host's cookies. It concerns the same threat (a malicious installed app) and
  may change how origins and sessions are distributed. This plan should be revisited when it lands.

## Open Questions

1. The manifest declaration and its review: a new role, a capability, or a Core permission.
2. Whether Core itself (permission and review pages) belongs in every app's list.
3. How a newly designated embedder reaches running apps without forcing restarts.

## Deliverables

- [ ] D1. Manifest declaration of an embedder, its operator review, and its projection into the app record.
- [ ] D2. Core distributes the designated embedders' browser origins to apps.
- [ ] D3. SDK sends `frame-ancestors` from that list, with tests for allowed, foreign and chained ancestors.
- [ ] D4. Shell declares itself an embedder.
- [ ] D5. Compatibility with the assistant browser runner, verified against the sandbox runtimes design.
- [ ] D6. Browser acceptance: an undesignated installed app cannot frame another app, and Shell can.
- [ ] D7. Feature docs, versions, this plan deleted and the index regenerated.
