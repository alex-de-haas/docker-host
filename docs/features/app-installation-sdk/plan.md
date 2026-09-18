# Independent App Installation SDK — Remaining Verification

Status: In Progress
Created: 2026-09-18
Updated: 2026-09-18

## Goal

Complete verification of the implementation described in [feature.md](feature.md). The owner
approved independent Marketplace/Shell installation, manifest-declared app permissions and
Core-owned final confirmation on 2026-09-18, then authorized local deployment and browser testing.

## Remaining Deliverables

- [ ] Complete an installation from embedded Marketplace, including a generic embedder with no
  installation responder, and verify frame reload after revoking installation grants. Both
  embedded surfaces load with an authenticated app session; the
  in-app browser's automation currently fails to activate controls inside the iframe.
- [ ] Verify popup-blocker fallback and mobile layouts in a browser with working popup/viewport
  automation. The current in-app browser opens separate native popup windows outside the tool's
  tab inventory and ignores the requested viewport override; these checks are not recorded as passed.
- [ ] Verify a request's continuation through a fresh Core login and rejected shared-cookie origins
  in the real browser. HTTP tests cover both, but the live installation used an existing fresh session.
- [ ] Verify live runtime switching cannot grow the approved permission set. Live-source restart
  retained empty Marketplace grants until its explicit reviewed update; automated tests also reject
  queued updates that add permissions and source drift after review.
- [ ] Fold any remaining verification fixes into feature.md, delete this plan once every deliverable
  is complete, and regenerate the index.

## Local Environment

The owner installation at `~/.hosty` runs Core from this checkout with `DOTNET_ENVIRONMENT=Development`.
Its listen address remains `http://localhost:7070`. Browser origins are:

- Core: `http://core.hosty.localhost:7070`.
- Shell: `http://shell.hosty.localhost:7171`.
- Marketplace: `http://marketplace.hosty.localhost:26495`.
- Other previously loopback public app endpoints: `http://apps.hosty.localhost:<existing-port>`.

These sibling hostnames isolate Core cookies while keeping HTTP app cookies same-site inside Shell.
The existing app ports and source overrides are unchanged. Public-origin settings were configured
through Core; previous values are saved locally at `/tmp/hosty-install-qa-origins.json` for rollback.
Newly installed apps also need a same-site public origin before testing their embedded UI; the Core
assigned local endpoint remains a loopback IP for server-side health checks.
No hosts-file edit was required in the Chromium-based in-app browser. OS command-line clients may
need an explicit loopback address rather than relying on the browser's `.localhost` resolution.

For a later source-mode restart, use the installed CLI with an explicit project path and development
mode, preserving the same data root. Do not launch a second Core against this installation:

```bash
hosty core stop --keep-apps
DOTNET_ENVIRONMENT=Development hosty core start \
  --project /Users/haas/Sources/haas/docker-host/apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj \
  --foreground
```

Marketplace acquired `apps.install` through the reviewed CLI update path; its previous empty grant
was verified to reject preparation. A pre-update backup was created by Core. Shell currently uses
its existing operator-session transport rather than delegated app credentials.

## Browser Verification Completed

- A fresh Core dev login reaches Shell on the new hostname; Shell's cookie-authenticated API works.
- Marketplace loads standalone, embedded in Shell, and in a static generic embedder without message handlers.
- Marketplace without an approved grant displays Core's `apps.install` refusal; after reviewed
  migration it can prepare and submit an installation.
- Demo App 0.11.1 was installed through Marketplace and Core confirmation. Both Docker services are
  healthy; the dialog closed and the catalog changed to `Installed` without a reload.
- Installed Demo App opens inside Shell with `Session Active` and `Directory Ready` after its public
  origin was moved onto the same site.
- Existing Project Manager also opens and renders its authenticated workspace on the new app hostname.
- Shell prepares a local fixture and submits it to Core. Cancellation is shown by Core and polled
  back to Shell as `Installation cancelled`; the fixture is absent from the app registry.
- Escape closes the SDK dialog. Desktop layout, runtime/settings fields and frozen pending state
  were visually inspected.
- The owner verified on 2026-09-18 that both Cancel and Install automatically close the native Core
  confirmation popup. HTTP tests cover both responses, the closing script's CSP hash and completion
  of the background installation after the response.

## Fixes Found By Live Testing

- The app-local SDK adapter accepts an explicitly configured public origin because Next.js can
  expose an internal request URL. Cross-origin and forged forwarded-host requests remain rejected.
- Explicit reviewed plans for live-source permission updates survive list reads and fleet sweeps;
  normal live-source update offers remain suppressed and changed source invalidates approval.
- Core confirmation uses `Referrer-Policy: same-origin`. `no-referrer` caused native form POSTs to
  carry `Origin: null`, leading to a legitimate user decision being rejected with HTTP 403.
- Shell and Marketplace allow `*.hosty.localhost` for development resources.

## Automated Verification

- Final Core full suite after review fixes: 1981 passed, 4 existing opt-in integration tests skipped.
- Core Native AOT publish for osx-arm64 passed without new trim/AOT warnings after review fixes.
- Focused update-snapshot, fleet-sweep and confirmation suite: 44 passed.
- SDK: 104 tests passed and package build passed.
- Marketplace: 104 tests passed, lint passed, and production Webpack build passed after the adapter fix.
- Shell after review fixes: 162 tests passed, lint passed with two existing navigation warnings,
  and the Webpack production build passed. Marketplace lint also passed after grouping imports.
- Review regressions: the four feed-cache/audit-failure cases failed before the fix; the focused
  Core suite now passes all 62 cases. Grant projection and sandbox policy have automated coverage
  across workspace/settings/panel wiring; live popup/revocation behavior has not been rechecked
  after this refinement.
- Version consistency, documentation index and whitespace checks pass.

## Version Outcome

Platform 0.104.1 → 0.105.0; SDK 0.13.0 → 0.14.0; Marketplace 0.4.3 → 0.5.0;
Shell 0.78.1 → 0.79.0. These versions describe the feature against its current `main` baseline;
the parallel Core development-mode PR also changes the platform and Shell versions, so the
second PR to merge must reconcile the version outcome against the updated baseline.
