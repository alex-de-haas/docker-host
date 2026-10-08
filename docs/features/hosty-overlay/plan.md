---
status: In Progress
created: 2026-10-08
updated: 2026-10-08
summary: A standard SDK root component coordinates loading, authentication, required permissions and content visibility without app-owned overlay UI.
components: [packages/app-sdk, apps/shell, apps/marketplace, apps/plans, apps/demo-app, apps/harness, apps/telemetry-ui]
---

# Hosty Overlay — Remaining Acceptance

## Remaining Scope

The SDK overlay and all six consumer migrations are implemented; current behavior and integration
live in [feature.md](feature.md). The owner authorized implementation on 2026-10-08. Authentication,
code exchange and storage contracts remain unchanged. Element picking and screenshots remain a
separate [App Feedback Inbox](../app-feedback-inbox/plan.md) feature.

## Deliverables

- [x] D1. Provide the shared SDK session coordinator and standard server adapters, including role-appropriate required-setup readiness, while preserving existing auth and transport contracts.
- [x] D2. Implement the root HostyOverlay with coordinated readiness, fixed light/dark presentation, accessible interaction blocking and transitions without intermediate content flashes.
- [x] D3. Integrate existing recovery with same-user in-memory restoration, different-user document reload, safe handling of pending requests and a session-restored notification.
- [x] D4. Migrate all six in-repository React consumers and verify an unchanged consumer can receive standard overlay changes through an SDK dependency update alone.
- [ ] D5. Complete automated and Core-managed browser verification, publish integration guidance and feature documentation, apply release version bumps, remove this plan and regenerate the index.

## Verification Completed

- SDK tests cover initial readiness and delayed responses, role-dependent setup, optional/unsupported
  grants, superseded probes, protocol/native handoff, retained portal state, activity expiry,
  same/different actor recovery, cookie-only renewal and pending mutations. A renewed identity with
  unresolved required permissions stays blocked; later readiness restores the same tree without
  replaying previously rejected writes.
- SDK compilation and all six production UI builds pass in the isolated PR worktree with workspace
  source exports, as well as the earlier disposable builds against published SDK exports. The SDK
  suite has 364 tests; Shell has 181 Node and 149 component tests; Plans has 61, Marketplace 104,
  Telemetry UI 10 and Demo App 4. All consumer lint commands pass with two existing Shell warnings.
- Harness requires its static UI build before the gateway's page test. The gateway's 52-test suite
  passes independently; full-suite results are recorded with the PR verification.
- The dependency upgrade fixture uses byte-identical consumer source against two SDK presentations.
  Published exports resolve and protected content remains absent before readiness.
- Native Chrome acceptance uses normal password login and Core-managed apps in an isolated data
  root. Shell's cookie-only sign-in, embedded Plans and standalone Plans pass. A shortened fixed
  activity deadline displays the overlay without a failed request; Escape cannot dismiss it and
  keyboard focus remains on its action. Same-user renewal restores the prior Plans search value.
- Light and dark presentation have been inspected in Shell. Adding a required permission to the
  disposable Plans manifest blocks the app; Core review cancellation keeps it blocked and approval
  returns to the previous page. Stopping the isolated Core with apps retained produces an error
  overlay; restarting that Core and retrying restores the entered search value.
- Reduced-motion behavior is verified by the SDK's CSS media rule; portal and delayed-readiness
  behavior have component coverage. The original in-app browser could not complete cross-origin
  form navigation; the successful browser flows above use native Chrome.
- Version consistency and documentation validation pass. Release versions: SDK 0.22.0, Shell
  0.96.0, Plans 0.3.0, Marketplace 0.8.0, Demo App 0.14.0, Harness 0.45.0 and Telemetry 0.14.0.
  No Core or .NET SDK version change belongs to this feature.

## Remaining Acceptance And Approval

D5 still requires live account-switch and regular-user setup acceptance. Their SDK tests pass;
browser verification needs a second administrator and a regular user assigned to Demo App in an
isolated Core data root. Creation uses normal invitation/password APIs and requires operator
approval for those test roles and assignments.

Test-account creation has not been approved or performed. The pull request remains a draft until
that browser acceptance is complete, or the owner explicitly accepts automated coverage for those
cases. Keep D5 open; on completion delete this plan and regenerate the documentation index.
