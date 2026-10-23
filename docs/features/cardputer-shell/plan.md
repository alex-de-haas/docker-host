---
status: In Progress
created: 2026-07-31
updated: 2026-10-23
summary: Finish the Cardputer ADV operator console with fast startup and explicit status refresh instead of continuous monitoring.
components: [apps/shell-cardputer]
---

# Cardputer Operator Shell

## Goal And Owner Decision

On 2026-10-23 the owner requested an audit, an updated firmware image and a USB
flash of their Cardputer ADV. The intended use is a short session: turn it on,
quickly see app status, attention and existing update counts, act if needed, and
turn it off. This explicitly replaces the previous continuous-monitoring scope.
Online/Eco/deep standby, motion wake, background notification delivery and battery
endurance targets are retired. There is no new standby mode to validate.

The implementation remains native ESP-IDF firmware, not a Hosty runtime app.
Use its native build and physical-device verification paths; do not invent a
Docker runtime for the device or change the operator's running Core.

## Approved Home And Startup Refresh

On 2026-10-23 the owner approved refreshing Home and startup, updating PR #647
and flashing the connected device. This extends the existing In Progress scope.

The design is a compact instrument panel, with the check outcome as its strongest
visual element. Keep the existing 6 x 8 pixel font, use 2x text for the outcome and
3x digits for Attention/Updates, and left-align supporting text. The restrained
Amber palette uses black (#000000), slate (#494955), white (#FFFFFF), muted gray
(#9292AA), amber (#FFB600) and error red (#FF4955), with RGB332-compatible values.
Ocean and Violet remain available. No new fonts, animation, framebuffer expansion
or artificial startup delays are needed.

Home layout: header; large outcome; first affected app/reason; Attention and
Updates counts; compact runtime/alert/Core-update context; explicit refresh and
check age in the footer. Core version moves to Device. A successful old snapshot
remains neutral; failed reads and disconnected/revoked states remain distinct.
Unknown supplemental data never produces an all-clear outcome.

Startup layout: stable title and detail; three fixed steps (Wi-Fi, Core, Apps);
only completed/current step emphasis changes. Existing setup, authorization and
error dialogs retain precedence. App data replaces startup immediately when read.
This deliberately favors status legibility over adding dashboard decoration.

## Target Behavior

- Reuse one serialized HTTP connection and remove the permanent SSE connection.
  Release idle transport memory and release it before OTA. Keep certificate and
  hostname validation, bounded streaming parsers and explicit authorization.
- Display app counts as soon as the required Core/app reads finish. Fetch
  notifications and the cached Core update verdict afterwards. Do not launch
  a fleet update check at boot. Never display unloaded data as a successful zero.
- Start SNTP without blocking a local HTTP connection. HTTPS still requires a
  valid clock at or after the firmware build time.
- Refresh on boot and explicit request. Briefly follow an operator-started
  operation with bounded polling; no recurring idle refresh or event stream.
  Show snapshot age, errors and loss of connectivity honestly.
- Keep the display on until the physical power switch is used. Remove standby,
  timer wake, motion sensing and their settings. Retain theme, explicit alerts,
  credential management and battery guards for writes/OTA. Ignore legacy power
  keys without deleting network settings or the authorization token.
- Align attention with maintained Shell semantics, including unhealthy running
  apps, setup/permission problems and restart requirements. Preserve unknown
  enum handling and review-required update restrictions.
- Update supported commands to current Core contracts. Mutations must not be
  silently retried on transport failure; an accepted asynchronous operation is
  not evidence of completion.

## Existing Work And Retired Scope

D1 and D6 retired the endurance target on 2026-08-02. D3-D5 and D7-D11 completed
the original bounded-parser, hardware-spike and authorization integration work.
D13-D15, D18-D20 and D23-D25 implemented the build, transport, operator UI,
notifications, battery guards and A/B OTA. D21-D22 implemented the standby
modes now explicitly retired by the owner. D27-D31 recorded initial evidence,
versioning, release artifacts, disclosure and CI. These IDs remain retired or
completed and are never reused. Git history retains their original acceptance
notes; they are not claims of verification against the current Core.

## Deliverables

- [ ] D2. Finish board evidence relevant to this console: confirm target identity,
  flash layout and keyboard/display ownership on hardware. Motion/RTC evidence
  for unattended standby is retired with that use case.
- [ ] D12. Verify revocation on the next explicit refresh and operation against
  Core. In-flight SSE revocation is retired because the firmware removes SSE.
- [ ] D16. Add explicit persisted settings schema/migration and incompatible-schema
  rollback handling before OTA health confirmation. Preserve working credentials.
- [ ] D17. Extend host coverage to separable storage and clock logic used by the
  native main units, including migration, unset clocks and build-time floors.
  Clock-floor coverage passes; separable storage/migration coverage remains.
- [ ] D26. Verify OTA downgrade refusal, pending-image confirmation and rollback.
- [x] D32. Build and flash a release candidate on the connected Cardputer ADV,
  record first-data/startup timing, heap, keyboard/refresh behavior and normal
  integration with its configured Core. Preserve NVS; report unavailable checks.
  Version 0.2.0 is flashed and normal HTTPS reads, retained credentials, boot
  timing and idle behavior pass. On 2026-10-23 the operator also confirms
  Home R refresh and keyboard navigation through Apps and Device work normally.
- [x] D33. Document verified current behavior in feature.md, retain this plan only
  while unchecked hardening work remains, and regenerate the documentation index.
- [x] D34. Remove continuous monitoring, standby modes and motion work; provide
  explicit refresh and bounded operation follow-up with an honest snapshot age.
- [x] D35. Reuse serialized HTTP transport, prioritize the first app snapshot,
  avoid the LAN clock wait and add startup/request timing diagnostics.
- [x] D36. Correct current Core compatibility and attention-state interpretation,
  with regressions for running apps that still require attention.

- [x] D37. Refresh Home and startup with clear outcomes, prominent Attention and
  Updates, bounded problem text, neutral snapshot age and preserved failure states.
- [x] D38. Verify healthy/problem/loading/failure layouts, build and flash the
  updated firmware, and publish the verified change in the existing PR #647.
  Version 0.2.1 passes native build, host/render/layout checks and USB hash
  verification. The operator confirms readable Home and working R refresh;
  the serial capture also records a successful explicit full refresh.

## Verification

Run host tests, rendering checks, the pinned ESP-IDF 5.5.4 production build,
version consistency and documentation/link checks in the registered workspace.
Inspect the generated 240 x 135 views. Use the same physical device for before
and after timings when USB access is available, and distinguish first app data
from completion of supplementary reads. Check failures retain last-known data
and show missing/stale information. Hardware access is required to claim a USB
flash or a measured startup improvement.

The unfinished migration/rollback deliverables predate this request and remain
visible. Do not call the entire original firmware release plan complete merely
because startup optimization passes.
