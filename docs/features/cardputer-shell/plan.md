# Cardputer Operator Shell

Status: Ready
Created: 2026-07-31
Updated: 2026-07-31

## Goal

Add a dedicated M5Stack Cardputer ADV firmware that acts as a pocket-sized
Hosty operator console. It keeps an authenticated connection to one Core host,
shows host and app state, performs the intentionally limited administrative
actions described here, receives audible notifications while the display is
off, and updates both Hosty workloads and its own firmware safely.

The deliverable is a native firmware artifact under `apps/shell-cardputer`, not
a Hosty runtime app. It does not run applications or embed their user
interfaces. Its first release is versioned independently from the platform,
the web Shell, and the Swift Shell.

## Product Boundary

**The firmware is a public artifact.** Anyone may flash it onto their own
Cardputer ADV and point it at their own Hosty host, and the audience is not
limited to this repository's author. That fact drives several decisions below —
onboarding has to work without a serial console, the storage and integrity
trade-offs are being accepted on strangers' behalf and therefore belong in the
user-facing documentation rather than only here, and the published runtime
figure is a promise rather than a note to self.

The first release provides:

- Core reachability, version, update availability, and restart/update status;
- app inventory, health, runtime state, autostart state, and a bounded recent
  log tail;
- app start, stop, restart, autostart change, and supported update operations;
- fleet update checks and routine update-all;
- notification counters, compact notification details, and configurable sound;
- keyboard-driven Wi-Fi, Hosty endpoint, time zone, alert, display, motion, and
  firmware settings;
- unsigned firmware OTA from a compiled-in origin over validated HTTPS, with
  A/B rollback.

The first release deliberately excludes:

- rendering or launching runtime app interfaces;
- Marketplace browsing, app installation, and app removal;
- app configuration, secrets, user administration, access-policy editing,
  mounts, backups, ingress administration, and host shell access;
- applying updates that Core marks as requiring operator review; they are
  listed with their reason and applied from Shell;
- arbitrary Core API requests or a general-purpose terminal;
- multiple active Hosty profiles;
- support for the original Cardputer or Cardputer v1.1.

Those exclusions are interface and memory boundaries, not placeholders for
unfinished deliverables in this plan. The permission-shaped ones — install and
removal, secrets, user administration — are absent from the *interface*, not
from the token, which carries full administrator rights; see
[Security Boundary](#security-boundary).

Three further omissions are deliberate cost decisions rather than boundaries,
listed here so no later reader mistakes them for oversights: no device passcode
or local lock, no encrypted credential storage or Secure Boot, and no firmware
image signing. The reasoning is in [Security Boundary](#security-boundary) and
[Firmware Update And Recovery](#firmware-update-and-recovery).

## Hardware Constraints

The target is M5Stack Cardputer ADV with an ESP32-S3FN8, 8 MB flash, 512 KB
internal SRAM, no assumed PSRAM, a 240 x 135 display, keyboard, speaker,
BMI270 accelerometer, and 1,750 mAh battery.

The board design affects the implementation:

- the BMI270 interrupt outputs are not connected, so motion cannot wake a
  sleeping CPU through a hardware interrupt; online standby polls the sensor;
- the keyboard interrupt is connected and can wake the UI task;
- GPIO38 controls the display-backlight power rail and the RGB LED together,
  so an off backlight also rules out RGB-only notifications;
- the speaker remains the notification channel while the display is off;
- the built-in power API exposes battery voltage/percentage but not current,
  and no bench power analyzer is available, so runtime is accepted from
  observed battery drain over real runs rather than from a current trace.

The firmware uses direct, compact rendering and bounded buffers. It does not
host a browser engine, React application, LVGL scene hierarchy, SVG pipeline,
or an unbounded in-memory copy of Core responses.

## Dependencies And Existing Feature Interaction

### Shared authentication prerequisite

**Core has no credential a headless device can obtain.** It accepts a session
as `Authorization: Bearer <session id>` — the form the Swift Shell uses — but
that session can only be created by posting Core's HTML login form, which is
why the Swift Shell signs in through a `WKWebView` on Core's `/login` page
([auth-gateway](../auth-gateway/feature.md),
[swift-shell](../swift-shell/feature.md)). A device with a thumb keyboard and
no browser engine has no path through that form, and this plan does not create
one by typing an administrator password into the device.

The mechanism Cardputer needs — Shell-approved device-code authorization
producing an opaque, revocable access token held as a server-side record — is
owned by [`access-tokens`](../access-tokens/feature.md), extracted on 2026-07-31
from the remote CLI direction in
[`ai-agent-bridge`](../ai-agent-bridge/plan.md) because its consumers are not
Cardputer-specific: remote CLI contexts, monitoring scripts, the MCP connector,
and this device all want the same credential. Cardputer consumes it and adds
nothing of its own.

Three properties of that credential are load-bearing here, and all three are
settled in that plan:

- **Lifetime** is idle-only with no absolute expiry, so a console that is used
  keeps working. Host browser sessions carry a 30-day absolute window, which a
  pocket device cannot live with.
- **Revocation is immediate and closes the device's open event stream**, not
  only its next request — otherwise an established SSE connection keeps feeding
  notifications to whoever holds the device.
- **Revocation is one action** in a Shell credential list, against an entry the
  operator can recognize by label.

**The credential carries the approving user's full role**, because Core has no
scopes and `access-tokens` defers adding them. That shapes this feature's
security story, and [Security Boundary](#security-boundary) states the
consequence rather than assuming a narrower token.

Onboarding and authenticated Core integration are blocked until that shared
capability ships. Phase 0 does not wait for it (see [Phases](#phases)).

### Transport

Both transports are supported, and the operator picks by typing an origin:

- **HTTPS with validated certificates**, for a Core reachable over the public
  internet — through [`cloudflare-ingress`](../cloudflare-ingress/feature.md)
  today, or the user-managed origin
  [`core-public-origin`](../core-public-origin/plan.md) plans. Required for any
  origin outside the local network.
- **Plain HTTP on a local network**, which is what
  [`advertised-app-origins`](../advertised-app-origins/plan.md) already leaves
  LAN origins on. This is a supported configuration, not a development-only
  escape hatch.

The device sends its token on every request, so on a plain-HTTP origin the
token is visible to the local network. That is accepted: a LAN is treated as a
trusted network here, and anyone already on it sits in roughly the same trust
bucket as anyone who can pick the device up off a table — an exposure this
release accepts knowingly and in the same breath. The two must be disclosed
together, and in the firmware's own README rather than only here, because on a
WPA2-PSK network "on the LAN" means "knows the Wi-Fi password", which in most
households includes guests.

Requiring TLS on the LAN was considered and dropped. It would need a Core that
can serve TLS at all, and Core cannot: it binds `http://localhost:{port}`
([HostyCoreApplication.cs:888](../../../apps/core/src/Haas.Hosty.Core/HostyCoreApplication.cs)),
carries no Kestrel HTTPS configuration, and takes TLS entirely from an external
tunnel or proxy. A LAN origin also cannot obtain a publicly-trusted
certificate, so the path would be a Core-generated self-signed certificate plus
a fingerprint the operator confirms during device-code approval — a real design,
but one that starts with a TLS listener in Core and belongs to a Core feature,
not to this one.

Transport is also an input to the power budget: Core's event stream sends a
keep-alive comment every 20 seconds because a Cloudflare origin closes an idle
response at roughly 100 seconds
([EventStreamEndpoints.cs](../../../apps/core/src/Haas.Hosty.Core/EventStreamEndpoints.cs)).
A device routed through Cloudflare therefore has a floor under how long its
radio may sleep, while a LAN device may not.

### Core and Shell behavior

The client follows the contracts described by
[`core-api`](../core-api/feature.md),
[`core-event-bus`](../core-event-bus/feature.md),
[`runtime-app-update`](../runtime-app-update/feature.md), and
[`notifications`](../notifications.md). State semantics and update safety must
remain aligned with [`swift-shell`](../swift-shell/feature.md) rather than
forming a second interpretation of Core state.

Any Core API addition that survives the feasibility spike must be generic for
small operator clients, documented in the owning Core feature, and tested as a
platform contract. No endpoint may be named or shaped only for Cardputer.

## Target Behavior

### Onboarding And Revocation

1. The device collects 2.4 GHz Wi-Fi credentials through its keyboard and
   stores them in plain non-volatile storage. WPA2-Enterprise, hidden SSIDs,
   captive portals, and 5 GHz networks are unsupported.
2. The operator enters or selects a Hosty Core origin — HTTPS anywhere, or
   plain HTTP on a local network. An HTTPS origin needs the clock set first
   (see [Time](#time)); a LAN origin does not.
3. The device starts the shared device-code authorization flow and displays a
   short code and approval URL.
4. The normal Shell shows the pending request with its label and age, and
   records an explicit, deliberate approval.
5. Core returns a device-bound, revocable access token carrying the approver's
   full role, stored unencrypted. The device never stores an administrator
   password or submits the browser login form.
6. The device reads `/api/auth/session`, which already returns the approving
   user's role. **Cardputer is an administrator's console**, and every operation
   it offers beyond reading needs that role, so a device authorized by a
   `host.user` says so plainly and asks the operator to approve again from an
   administrator account rather than failing later, one denied action at a time.
   The same warning appears at the approval step, where it is still cheap to fix.
7. Revocation, expiry, or role loss returns the device to a safe, read-only or
   reauthorization state without deleting local network settings.

The Shell credential entry shows the device label, approving user,
authorization time, last-seen time, and a revoke action. The device shows the
same label on screen, so an operator who has lost one of several devices can
tell which entry to revoke.

**A lost or stolen device is handled by revoking its token**, which is the only
mitigation this release offers and therefore has to be quick and complete:
Shell's device list is reachable without first identifying the device by an id
printed nowhere, and revocation ends the device's event stream rather than
waiting for its next request.

### Time

The ESP32-S3 keeps time across deep sleep but not across a loss of power, so
after every cold boot the time is unknown — and without it no certificate can
be judged. The bootstrap order is not circular, because plain SNTP runs over
UDP and needs neither a valid clock nor TLS:

```text
Wi-Fi → SNTP → clock valid → HTTPS to Core
```

- Until the clock is set the device shows that state explicitly and makes no
  HTTPS request. It never relaxes certificate validation to get moving.
- **SNTP is unauthenticated**, so whoever controls the network can set the
  device's clock — including winding it back until an expired or revoked
  certificate looks valid again. The device therefore refuses any time earlier
  than its own firmware build timestamp. That costs a few lines and closes
  rollback *below the build*, which is the cheap and worthwhile half. It does
  **not** close rollback in general: an attacker who controls SNTP and holds the
  private key of a certificate that expired *after* the build can still pick a
  moment where that chain validates. The floor narrows the window to
  "certificates that expired since this firmware was built"; it does not remove
  it, and the residual case is recorded with the signing decision below.
- **A plain-HTTP LAN origin needs no clock to connect**, because nothing is
  being validated. A device that cannot reach NTP still works against a LAN
  Core; only quiet hours and displayed timestamps degrade, and they say so
  rather than showing a wrong time confidently.
- Quiet hours need local time, so the Device view carries a time zone.

Whether the ADV has a battery-backed RTC is a Phase 0 question. If it does,
cold boots are quicker and offline behavior is better; if it does not, nothing
breaks and SNTP is simply always required for an HTTPS origin.

### State Synchronization

- The device establishes an authenticated SSE connection for change hints and
  notification delivery.
- Initial connection and every reconnect perform a full bounded resync before
  the UI reports current state. SSE events are never treated as the complete
  source of truth.
- Core restart, network loss, token expiry, and transient HTTP errors are
  distinct states with bounded exponential reconnect and visible stale-data
  age.
- Unknown future enum values degrade to `unknown` and never crash the UI or
  accidentally enable an operation.
- The firmware declares the minimum Core version it supports and shows an
  explicit unsupported state below it, the way the Swift Shell already does.
  Firmware and platform update on independent schedules, so version skew is the
  normal case rather than an edge case.
- An app is busy only for the same operation/runtime states recognized by the
  maintained Shell clients. Lifecycle controls remain disabled while an app or
  Core operation is in flight.
- Collections, strings, log records, and JSON nesting have explicit maximums;
  oversized responses fail visibly and do not exhaust the device heap.

### Operator Interface

The keyboard-first interface has four top-level views:

1. **Dashboard** — connection and battery state, Core version/update state,
   app health counts, active operations, and unread notifications.
2. **Apps** — searchable compact list, detail/status view, start/stop/restart,
   autostart toggle, supported update action, and bounded log tail.
3. **Updates** — check progress, routine updates, apply-by-digest confirmation,
   and reconnect/resync after Core update. An update Core marks as requiring
   operator review is listed with its reason and a note that it is applied from
   Shell.
4. **Device** — endpoint, Wi-Fi, time zone, sound, screen timeout, motion
   policy, authorization, diagnostics, firmware version, and firmware OTA.

All mutating actions provide immediate in-flight feedback and an explicit
success or failure result. System-app start, stop, restart, and autostart
controls remain absent, matching the normal Shell; supported system-app updates
and Core operations use stronger confirmation. Routine updates may use a single
confirmation for update-all. Displaying a full review-required update plan on a
240 x 135 screen — every reported change, read and understood before a
deliberate confirmation — is the highest-cost, highest-consequence surface in
the whole interface, and it is the reason those updates stay in Shell.

### Display, Motion, And Notifications

The default power policy has three modes:

- **Active** — display and backlight on, normal keyboard interaction, active
  refresh while an operation is visible.
- **Online standby** — ST7789 sleep, GPIO38/backlight off, Wi-Fi connection and
  SSE retained, ESP-IDF power management enabled, keyboard wake enabled, and
  BMI270 sampled at a default 4 Hz.
- **Deep standby** — optional manual/night mode; Wi-Fi is disconnected and
  immediate remote notifications are unavailable. Wake uses supported timer or
  keyboard paths and is followed by full reconnect/resync.

Online standby wakes the display on keyboard activity or on motion above a
configurable threshold, followed by a cooldown. That is the whole algorithm:
there is no hysteresis, no debounce window, and no attempt to tell being
carried apart from being picked up.

The reason is that **the device has no function outside Wi-Fi range**, so
nobody carries it far or long, and the travel case this filtering would exist
for is not a real one. What remains is a device on a desk being picked up, and
the cost of a false wake there is a lit screen until the display timeout — not
worth an algorithm to avoid. Wake-on-motion is a nicety and is treated as one;
it can be turned off, and turning it off costs nothing else.

Because the accelerometer has no wired interrupt, motion is found by polling,
and the target motion-to-display latency is at most 250 ms at the default 4 Hz
sampling rate. Moving detection into the BMI270's own motion feature and
polling only its status is an available optimization if Phase 3 finds the wake
cost matters; with no filtering left to implement it is no longer a
simplification, so it is not the default choice.

An incoming notification can wake the CPU and play its configured sound while
the display remains off. Priority and quiet-hours policy decide whether the
display also wakes. Sound is rate-limited and can be muted independently of
network connectivity.

### Firmware Update And Recovery

USB-C flashing is always available and is the recovery path of last resort:
the device sits in its owner's pocket, not in a rack, so no failure mode here
is unrecoverable. OTA exists for convenience, and its scope is set accordingly.

- **The OTA origin is compiled into the firmware and is not operator-editable,
  and a Hosty Core is never a source of firmware or able to influence where
  firmware comes from.** These are two unrelated channels that happen to meet
  on one device: the Core origin is chosen per operator and points at an
  arbitrary host, while the firmware origin is this project's release host and
  is the same for everyone. Conflating them would let anyone running a Hosty
  Core push arbitrary firmware to a device that connects to it — a complete
  takeover of someone else's hardware through one setting.
- Firmware releases are downloaded over validated HTTPS. Images are **not**
  signed; the transport and the release host are the integrity boundary.
- Certificate validation is never relaxed for OTA, and OTA does not run while
  the clock is unset (see [Time](#time)).
- The partition layout uses the stock ESP-IDF A/B OTA scheme with rollback,
  within the 8 MB flash budget. No separate recovery partition is added.
  ESP-IDF already checks the image's own SHA-256 at boot, so a truncated or
  corrupted download rolls back rather than bricking the device.
- A new image marks itself healthy only after storage migration, display/input
  initialization, and a bounded Core connectivity check or an explicit offline
  timeout.
- Failed boot or failed health confirmation returns to the last known-good
  image.
- Interrupted download, low battery, version downgrade, and incompatible
  storage schema are handled without losing the working image.
- Firmware OTA is clearly separated from Hosty Core and runtime-app updates.

**OTA is in scope for `0.1.0`**, as the product boundary above promises. If
implementation shows it is not worth its cost — fragile, or eating flash the
rest of the firmware needs — that is a scope change the user decides and this
plan records before the deliverable is closed, exactly like any other. It is
not a choice the implementation makes on its own, and the deliverable is not
checkable by dropping it.

**Why unsigned, and when to revisit.** Signing answers "who built this image",
and against the three ways an image can be substituted it earns less here than
it looks. In transit is already covered by validated HTTPS. Physically, over
USB-C, an app-level signature stops nothing at all without eFuse-backed Secure
Boot, which is deliberately out of scope. That leaves a compromised release
path — and a signature only helps there if the key lives somewhere the release
pipeline does not, which for a project this size it realistically would not.

The honest counterweight is that this firmware is public, so a compromised
release host reaches other people's devices, and those people cannot notice or
respond. What that argues for is a trustworthy published artifact — checksums
and build provenance, already a deliverable — rather than device-side
verification with a co-located key. Signing is revisited if the release process
ever gains a key kept off CI, or if the device population grows past what a
release note can reach; `SECURE_SIGNED_APP_NO_SECURE_BOOT` adds it in software,
without touching an eFuse, so this decision is reversible by design.

One residual case belongs here rather than in a footnote. Because HTTPS is the
only authenticity boundary for firmware, and the device's clock comes from
unauthenticated SNTP, an attacker who controls the device's network *and* holds
the private key of a certificate for the release host that expired after this
firmware was built can set the clock into that certificate's validity window
and serve an arbitrary image. The build-timestamp floor narrows this to expired
keys, not to none. It needs a compromised key to begin with, which is why it
does not change the decision — but it is a third entry on the revisit list
above, alongside a key kept off CI and a growing device population.

## Architecture

The implementation uses ESP-IDF with M5Unified/M5GFX for supported board
peripherals. FreeRTOS responsibilities remain explicit and bounded:

- `transport` owns TLS, HTTP, SSE framing, reconnect, and request cancellation;
- `auth` owns device-code enrollment, token lifecycle, and scope errors;
- `state` owns the normalized snapshot and deterministic event reduction;
- `commands` serializes lifecycle/update mutations and idempotency data;
- `ui` owns compact rendering, navigation, confirmation, and stale-state cues;
- `power` owns display/backlight state, motion sampling, sleep transitions, and
  battery policy;
- `alerts` owns notification filtering, sound, and quiet hours;
- `ota` owns image download over validated HTTPS, boot selection, and rollback.

Tasks communicate through fixed-capacity queues. Network parsing is streaming,
and the normalized state retains only fields needed by the product boundary.
Secrets never enter logs, crash reports, UI snapshots, or generic state events.

The first feasibility spike measures streaming consumption of the existing
`/api/apps` response with a large fixture. A compact Core projection is added
only if measured peak heap, latency, or transfer size cannot meet the budgets
defined by the spike. Pagination and field selection are preferred over a
device-specific aggregate endpoint.

## Security Boundary

**The device token is a full administrator credential.** Core has no scopes —
there are two roles and nothing finer — and [`access-tokens`](../access-tokens/feature.md)
deliberately defers adding them, so a device credential carries the entire role
of the user who approved it. Cardputer is an administrator's device, so its
token can do everything an administrator can do: install and remove apps, read
app secrets, manage users, edit mounts, ingress and backups.

The list of things this device *does* is therefore a description of the
firmware, not of the token:

- Core, app, update, and notification status reads;
- app start, stop, restart, autostart, and update;
- update check and routine apply operations;
- Core restart and Core update.

Everything else is absent because the firmware draws no control for it — and a
missing control is not an authorization boundary. Anyone who extracts the token
reaches the whole API with it. This section previously claimed Core enforced a
narrow capability set; that was written before scopes were deferred, and it was
wrong. Scopes are what would make the boundary real, and they belong to
`access-tokens` when that work is taken up.

**Everything at rest on the device is readable by whoever holds the device.**
The access token and Wi-Fi credentials are stored unencrypted, and there is no
device passcode, so possession of the hardware is possession of administrator
access to the host until the token is revoked. This is a deliberate decision,
and what it rests on is now thinner than it looks:

- revocation is immediate and reachable — which, with the narrow-scope argument
  gone, is no longer one mitigation among several but **the only one**;
- nothing on the device is a credential for anything else. It holds no
  administrator password, no session that outlives revocation, and no material
  that could re-mint access after revocation.

Encrypted NVS was considered and rejected as theater at this scale: its keys
live in a partition that only flash encryption protects, and the alternative
HMAC-based scheme needs an eFuse burn — while release tooling must never burn
irreversible eFuses automatically. Half-measures here would have obscured the
real boundary rather than moved it. ESP32-S3 Secure Boot and flash encryption
stay out of scope; if a managed-device profile ever needs them, it is a
separate feature with its own provisioning story.

The same holds on the wire when the operator points the device at a plain-HTTP
LAN origin: the token rides every request in the clear, so the local network
can read it. Both exposures share one trust assumption — that the people with
physical or network proximity to the device are the same people who already
have the run of the host.

Because the firmware is public, these trade-offs are accepted on behalf of
people who did not make them. **They are disclosed together, in the firmware's
own README, in plain words rather than as a footnote:** whoever holds this
device has full administrator access to your Hosty host until you revoke it,
and on a plain-HTTP origin so does anyone who knows your Wi-Fi password.

**Two channels, never joined.** The Core origin is operator-supplied and points
at an arbitrary host; the firmware origin is compiled in and points at this
project's releases. A Core must never become a source of firmware, because a
device that trusted its Core for firmware would hand full control of itself to
whoever's host it was pointed at.

Normal builds require certificate validation, and never relax it — including
when the clock is unset, in which case the request simply does not happen.

## Power And Resource Budgets

### The board's floor is measured first

Before any firmware architecture is chosen, Phase 0 measures how long the board
survives doing *nothing*: charged to full, ESP32-S3 in deep sleep, display and
backlight off, everything else as the hardware leaves it. Nothing the firmware
does can beat that number, so it is the ceiling on every runtime target here
and it costs an afternoon and one overnight run to learn.

There is no bench power analyzer, and the built-in power API reports voltage
and percentage but not current, so runtime is measured the way it is actually
experienced: hours from a full charge to a defined cutoff, logged from the
device's own battery percentage. Average current is derived from that result,
not measured directly — which is precise enough to decide anything this plan
decides.

### Budgets recorded in Phase 0

- peak and steady free heap for connect, full sync, app list, SSE reconnect,
  log tail, and OTA;
- firmware image and A/B partition headroom;
- TLS handshake and full-sync duration on a representative large host;
- the deep-sleep floor run above;
- observed standby runtime in two configurations — event stream held open
  against Core's 20-second keep-alive, versus the stream closed and
  `/api/notifications` polled on a slower cadence. A battery device may do
  better with periodic polling than with a connection it must keep waking to
  service, and if it does, Deep standby loses most of its reason to exist.

### The runtime target is provisional

A 1,750 mAh battery lasting 48 hours implies roughly **36 mA average** for the
whole device. That is the working target, deliberately written in the units
that make it checkable, and it is **provisional**: it was chosen before the
floor was known, and Phase 0 replaces it with a number derived from the
measured floor. Committing to it now would be committing to an outcome nobody
has evidence for.

The acceptance profile is room temperature, stable 2.4 GHz Wi-Fi, display off,
the standby transport chosen above, 4 Hz motion sampling, and one audible
notification per hour. Acceptance is two overnight-or-longer runs, with the
observed hours, firmware build, access point settings, and battery age retained
with the feature evidence.

Once Phase 0 sets the number, missing it leaves the deliverable incomplete
until either the implementation meets it or the user approves a revision and
this plan is updated.

## Deliverables

### Contract And Feasibility

- [ ] Measure the deep-sleep board floor and record it as the ceiling on every
  runtime target in this plan.
- [ ] Record the exact Cardputer ADV board revision, schematic assumptions,
  GPIO ownership, flash layout, whether a battery-backed RTC is present, and
  measured baseline behavior.
- [ ] Define and check in representative Core fixtures: at least 50 apps, large
  optional fields, unknown enum values, and long notification/log data, with the
  response sizes stated so the heap budget is checkable against a number.
- [ ] Prototype TLS with SNTP-set time, streaming app parsing, SSE reconnect,
  screen power control, keyboard wake, BMI270 polling, and speaker notification
  on real hardware.
- [ ] Compare standby runtime with the event stream held open against periodic
  `/api/notifications` polling, and choose the standby transport from the
  result.
- [ ] Establish heap, image-size, latency, and runtime budgets, replace the
  provisional runtime target with a measured one, and record the go/no-go.
- [ ] Decide from measurements whether a generic compact/paginated Core read
  contract is required; if required, document and implement it in the owning
  Core feature.

### Shared Authorization Integration

This group's Core and Shell work ships in the owning authentication feature's
own PR under the platform version, never inside the firmware PR.

- [x] The device credential exists — [`access-tokens`](../access-tokens/feature.md),
  shipped 2026-07-31: idle-only lifetime with no absolute expiry, revocation that
  terminates an in-flight event stream, and a Shell credential list. Note that it
  carries the approver's full role; see [Security Boundary](#security-boundary).
- [ ] Consume the shipped device-code flow and credential without adding
  Cardputer-only credentials, endpoints, or storage.
- [ ] Implement the administrator-role check on `/api/auth/session`, warning at
  approval time and after enrollment when the device was authorized by a
  `host.user`.
- [ ] Verify against the shipped implementation that revoking this device's
  credential ends its in-flight event stream, not only its next request.

### Firmware Foundation

- [ ] Add reproducible ESP-IDF build tooling and the `apps/shell-cardputer`
  source tree, with pinned toolchain/dependencies and a documented USB-C flash
  path.
- [ ] Add a host-side render harness so the four views can be developed and
  reviewed without hardware in the loop.
- [ ] Implement bounded configuration storage, Wi-Fi provisioning, SNTP time
  with the build-timestamp floor and the clock-unset state, time zone, endpoint
  validation, authorization, transport, state synchronization,
  minimum-Core-version handling, and diagnostics.
- [ ] Implement the keyboard-first Dashboard, Apps, Updates, and Device views
  with unknown/stale/busy/error states.
- [ ] Implement lifecycle, autostart, log-tail, Core operation, and routine
  update flows with confirmation and idempotency behavior aligned to Core, and
  surface review-required updates as read-only with their reason.

### Power, Alerts, And Recovery

- [ ] Implement Active, Online standby, and optional Deep standby transitions,
  including display sleep, GPIO38 control, Wi-Fi power management, keyboard
  wake, and motion wake as a threshold plus cooldown that can be switched off.
- [ ] Implement bounded notification delivery, priority/quiet-hours filtering,
  sound rate limiting, and screen-wake policy.
- [ ] Implement battery guards for mutation and OTA operations and expose
  understandable degraded-power states.
- [ ] Implement A/B firmware OTA from the compiled-in origin over validated
  HTTPS, with health confirmation, downgrade policy, and rollback tests.
- [ ] Meet and publish the runtime, heap, flash, and latency acceptance
  evidence against the Phase 0 targets.

### Release And Documentation

- [ ] Add Cardputer firmware to the repository release model and versioning
  instructions as an independently versioned native client, initially `0.1.0`,
  recording its version in one file under `apps/shell-cardputer` that
  `scripts/check-versions.mjs` reads.
- [ ] Add build, artifact checksum, build provenance, USB-C flashing, recovery,
  onboarding, revocation-on-loss, operation, and troubleshooting documentation,
  written for an owner who is not this repository's author.
- [ ] State the accepted exposures together in `apps/shell-cardputer/README.md`,
  in plain words and not as a footnote: whoever holds the device has the
  owner's Hosty access until the token is revoked, and on a plain-HTTP LAN
  origin so does anyone on that network — which on WPA2-PSK means anyone who
  knows the Wi-Fi password.
- [ ] Add CI for firmware build, tests, size budgets, and documentation checks.
- [ ] Exercise a release candidate on physical Cardputer ADV hardware against a
  Core-managed Hosty installation and retain the verification results.
- [ ] Create `feature.md` from shipped behavior, remove this completed plan, and
  regenerate the documentation index in the release PR.

## Phases

### Phase 0 — Hardware And Contract Spike

Measure the board floor, complete the real-device prototypes and remaining
measurements, settle the memory/API and standby-transport decisions, replace
the provisional runtime target, and reject any architecture that cannot fit the
hardware or runtime budget.

**This phase blocks on nothing and answers the questions that could end the
project**, so it runs first and separately, as a throwaway spike rather than
production code. It needs no device credential: a development build carries a
session id supplied over the serial console, which is exactly why it can start
before the shared authorization work exists.

### Phase 1 — Secure Foundation

Integrate the shipped device authorization, both transports, bounded transport
and state storage, Wi-Fi/configuration persistence, and reconnect semantics. The
exit criterion is a revocable device that stays synchronized without an
administrator password stored on it.

### Phase 2 — Operator Workflows

Ship the four navigation views and all in-scope read/lifecycle/update actions,
including confirmation, stale-state, unknown-state, and failure behavior. The
exit criterion is behavioral parity with maintained Shell state semantics for
the supported subset.

### Phase 3 — Standby And Alerts

Add screen/motion behavior, Wi-Fi power management, audible notifications,
quiet hours, and battery policy. Tune on hardware and meet the Online standby
runtime target.

### Phase 4 — Firmware OTA And Release Hardening

Finish A/B OTA and rollback, then negative security tests, CI/release
artifacts, physical-device acceptance, and final documentation.

Phases are not independently released, and the firmware ships as one PR
covering `apps/shell-cardputer` and these documents. The Core and Shell
authorization work is not part of it: it belongs to another feature, carries
the platform version, and lands in that feature's PR first — putting it in the
firmware PR would bump the platform version for a firmware change.

## Open Questions

None. Whether the existing Core read contract fits the heap and transfer
budgets is not an open question but a Phase 0 measurement, and it already has
its own deliverable.

### Resolved 2026-07-31

- **No credential encryption at rest, no Secure Boot, no flash encryption.**
  Tokens and Wi-Fi credentials are stored in plain NVS; fast revocation is the
  mitigation. Encrypted NVS was rejected as theater, since its key partition is
  only protected by flash encryption and the HMAC-based alternative needs an
  eFuse burn.
- **No device passcode or local lock.** Physical possession grants the device's
  rights, accepted knowingly and paired with immediate revocation. A future PIN
  would have to derive a key and encrypt the token at rest to mean anything —
  gating the UI alone is bypassed by a flash dump.
- **The credential carries its approver's full role, and no scopes exist.**
  [`access-tokens`](../access-tokens/feature.md) defers scopes, so the narrow
  operation list is a property of this firmware's interface and not of the
  token. The device warns when it was authorized by a `host.user`, because
  everything past reading needs an administrator.
- **One configured Hosty host.** Profile switching adds credential, stale-state
  and UI complexity without improving the pocket-operator workflow.
- **Plain HTTP is supported on a LAN, not just in development builds.** A local
  network is treated as trusted, so no TLS is required there and no certificate
  pinning is built. The alternative would have started with a TLS listener in
  Core, which does not exist. HTTPS remains required for any origin outside the
  local network, and both this and the physical-possession exposure are stated
  in the firmware README.
- **No firmware image signing.** Validated HTTPS plus A/B rollback is the
  integrity story, and USB-C reflashing is always available. A signature would
  not survive the USB-C path without Secure Boot, and would share a trust domain
  with the release pipeline. Revisit if a signing key is ever kept off CI.
- **The firmware is a public artifact, and the OTA origin is compiled in.** A
  Hosty Core is never a firmware source and cannot influence one; the Core
  origin and the firmware origin are separate channels by construction.
- **Motion wake stays, its false-wake filtering does not.** Threshold plus
  cooldown, no hysteresis or debounce: the device is useless outside Wi-Fi
  range, so the carried-around case the filtering existed for is not real.
- **No bench power instrumentation.** Runtime is accepted from observed battery
  drain, and the 48-hour figure is provisional until Phase 0 measures the floor.
- **Review-required updates stay in Shell.** Routine updates are applied from
  the device; review-required ones are listed read-only with their reason.
- **Firmware OTA is in scope for `0.1.0`.** Dropping it later would be a scope
  change the user decides and this plan records, not something implementation
  settles by leaving a deliverable unchecked.

Approved by the user on 2026-07-31, with the shared authorization dependency
now covered by a Ready plan of its own.

## Verification

Automated verification includes:

- host-side unit tests for JSON/SSE parsers, state reduction, reconnect,
  unknown values, operation gating, update classification including the
  routine/review-required split, minimum-Core-version handling, unset-clock
  behavior, rejection of a time before the build timestamp, the motion
  threshold, power transitions, and storage migration;
- Core contract tests for lifecycle/update idempotency and any compact read
  contract added by this work; device authorization, revocation and audit are
  verified by [`access-tokens`](../access-tokens/feature.md), not restated here;
- fixture tests at maximum supported app, notification, string, and log sizes;
- deterministic firmware builds, dependency/license checks, partition and
  image-size gates, and documentation-index checks.

Physical-device verification includes:

- clean USB-C flash, onboarding, authorization, revocation of a device that is
  powered on and connected, credential expiry, wrong device clock, and recovery
  without a reachable Core;
- Wi-Fi loss, AP restart, Core restart/update, SSE disconnect, reconnect storm,
  stale-state indication, full resync, and a Core older than the firmware's
  minimum;
- every supported lifecycle/update action, and the administrator-role warning
  when the device is authorized by a `host.user`;
- display timeout, keyboard wake, motion wake at each threshold setting and
  with motion wake off, quiet hours, sound rate limiting, and notifications
  with the display off;
- onboarding against both a plain-HTTP LAN origin and an HTTPS origin;
- cold boot with no clock against each origin type, a network that blocks NTP,
  and an NTP server answering with a time before the build timestamp;
- interrupted/corrupt/low-battery OTA, automatic rollback, and confirmation
  that no Core-supplied value can redirect where firmware is fetched from;
- the deep-sleep floor run plus two standby runs against the Phase 0 runtime
  target, logged from the device's own battery percentage.

The implementation PR records exact commands and results. At minimum it runs
the repository Core build/tests when Core contracts change, the pinned ESP-IDF
build and firmware tests, and `node scripts/docs-index.mjs --check`.

## References

- [M5Stack Cardputer ADV documentation](https://docs.m5stack.com/en/core/Cardputer-Adv)
- [M5Stack Cardputer ADV schematic](https://m5stack-doc.oss-cn-shenzhen.aliyuncs.com/63713/Cardputer-Adv_SCH.pdf)
- [ESP-IDF power management](https://docs.espressif.com/projects/esp-idf/en/latest/esp32s3/api-reference/system/power_management.html)
- [ESP-IDF OTA](https://docs.espressif.com/projects/esp-idf/en/latest/esp32s3/api-reference/system/ota.html)
- [ESP-IDF security overview](https://docs.espressif.com/projects/esp-idf/en/latest/esp32s3/security/security.html)
