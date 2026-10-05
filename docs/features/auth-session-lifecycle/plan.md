# Embedded Session Continuity

Status: Draft
Created: 2026-10-05
Updated: 2026-10-05

## Owner Direction And Observed Code

On 2026-10-05 the owner requested normal use of apps, assistant panels and embedded settings inside
Shell without repeated "Sign in via Hosty" clicks. Usability takes priority over repeated consent
for already granted access; keep Core-owned identity and application permissions. See
[vision decision 19](../../vision.md).

The SDK's browser grant fallback is document-local memory. A recreated frame without an accepted
app cookie probes as unauthenticated and offers a click-owned Core popup. Shell opens the app-owned
surface and has no silent identity bootstrap. The current architecture therefore loses continuity
when the cookie path is unavailable. The actual cookie/origin behavior on the reported live
installation still needs reproduction; iframe ownership alone does not explain cookie persistence.

## Owner Clarification (2026-10-05)

Shell must not own or be able to redeem credentials for a target app with greater authority than
Shell. The previous embedder-issued bootstrap proposal is not approved. A target-held proof alone
is insufficient if a malicious embedder can manufacture its own proof and request a target grant.
Before implementation, prove a direct Core-to-target browser exchange in which the embedder
cannot impersonate the target or redeem its grant. No session-continuity implementation is approved.

## Proposed Target

A normal Core sign-in establishes the user's identity. Opening or remounting an assigned app inside
Shell recovers that app's own session without repeated sign-in clicks. Shell owns neither the Core
session nor another app's credential, even when that app has greater authority.

Evaluate a Core-owned browser broker with direct messaging between the target app frame and Core.
Core must verify the actual message origin, sending window, registered app origin, installation and
user assignment before issuing a target-bound result directly to that frame. An app identifier or
proof supplied by Shell cannot establish target identity. Shell may coordinate layout and readiness,
but must not receive target tokens or codes it can redeem.

The prototype must establish how the Core-owned context is authenticated after normal top-level
Core sign-in when third-party cookies or storage are blocked or partitioned. Hidden iframes alone do
not solve that constraint. Evaluate app-origin session storage for remount continuity where browser
policy permits it; storage denial needs an explicit fallback. This is a candidate to validate, not
a claim of universal browser support.

Within the active Core user session, ordinary app activity renewal should avoid repeated per-frame
popups. Login, app permission grants, app activity and assistant execution leases remain distinct;
recovering a session must not approve new permissions or start an agent run. Explicit logout and
revocation refuse subsequent recovery. A temporary Core outage preserves mounted work and offers
retry. Closing/reopening an iframe is not logout.

Standalone apps retain their own session/recovery path. Use the same SDK mechanism for workspace
apps, settings surfaces and assistant panels, on both local and external registered origins.

## Deliverables

- [ ] Reproduce first open, second open, navigation away/back and simultaneous surfaces on the live
  origin topology; distinguish missing cookies, document-local token loss and activity expiry.
- [ ] Prototype the Core-owned broker and app storage lifetime under supported browser policies;
  prove that a forged Shell request cannot obtain target credentials. Obtain owner approval of the
  concrete exchange and fallback contract before production implementation.
- [ ] Implement the approved Core/SDK exchange, revalidation and automatic recovery;
  preserve target assignment, app grants, installation and logout/revocation boundaries.
- [ ] Cover races, replay, forged frame/target/user, wrong proof/origin, iframe remount, simultaneous
  surfaces, blocked third-party cookies, active-session renewal and unavailable Core.
- [ ] Verify normal Core password sign-in followed by repeated embedded workspace/settings/assistant
  navigation without extra sign-in clicks; verify standalone recovery and explicit logout separately.
- [ ] Build changed artifacts, run affected tests, bump versions, update auth/session and activity
  reality docs and SDK integration instructions; remove this plan and regenerate the docs index.

## Interaction With Existing Features

[Managed browser addresses](../public-origins/feature.md) provide origin presentation and local naming,
but session continuity must also work across registered external origins. The existing
[assistant autonomy selector](../assistant-session-autonomy/feature.md) controls native agent
approvals independently; session recovery must not silently enable autonomous command execution.
