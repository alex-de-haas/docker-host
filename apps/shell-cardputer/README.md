# Hosty Cardputer Operator Shell

Hosty Cardputer Shell is native firmware for **M5Stack Cardputer ADV**. It is
an administrator console for one Hosty Core host; it is not a Hosty runtime app
and cannot open runtime-app user interfaces.

The implementation is in progress. The firmware already builds for ESP32-S3,
with a short-session workflow: switch on, check the dashboard, refresh explicitly,
and switch off. Storage migration and OTA rollback acceptance remain tracked in
[the plan](../../docs/features/cardputer-shell/plan.md). Host-side protocol, state,
HTTP-adapter and rendering tests do not require
ESP-IDF or hardware. A firmware build uses ESP-IDF v5.5.4 and the exact
M5Unified/M5GFX versions recorded in `dependencies.lock`.

## Security warning

The device stores its Wi-Fi password and Hosty access token without encryption.
The access token carries all rights of the user who approved it. If an
administrator approves the device, whoever physically holds the Cardputer has
administrator access to that Hosty host until the credential is revoked in
Shell.

When the configured Core origin uses plain HTTP, anyone able to observe that
local network can read the token. On a typical WPA2-PSK network, that includes
anyone who knows the Wi-Fi password. Use an HTTPS Core origin when the local
network is not fully trusted.

The operator-supplied Core origin is never used for firmware updates. Firmware
OTA uses the project-controlled `cardputer-dev` release compiled into the
image. Images are unsigned: validated HTTPS, GitHub release access, published
SHA-256 checksums, and build provenance are the integrity boundary.

## First boot

The device setup is entirely keyboard-driven and does not need a serial
console:

1. Enter the 2.4 GHz Wi-Fi SSID and password.
2. Enter an HTTPS Core origin, or plain HTTP for a private/local-network host.
3. Enter a POSIX time-zone value and a recognizable device label.
4. For HTTPS, the firmware synchronizes time over SNTP and refuses TLS until
   the clock is at least as new as the firmware build.
5. Open the displayed approval URL in the normal Hosty Shell and approve the
   short code from a `host.admin` account. Approval by `host.user` is rejected
   and the device asks for a new approval.

Wi-Fi credentials and the revocable access token are persisted in plain NVS.
Changing the Core origin clears the old token so it cannot be sent to another
host. Losing the device is handled from Shell: open the active-credentials
list and revoke the entry carrying the same device label.

## Controls

Left and Right cycle through Home, Apps, Updates, and Device. The header names
the current page, shows the connection phase and snapshot state, and keeps battery state in
view. The footer shows only the controls that apply to the current page.
`Fn+1` through `Fn+4` remain available as direct, undisclosed page shortcuts.

Up and Down select an app or Device setting. Press `Enter` on an app, the
Updates page, or a Device action row to open a named action menu; each entry
also displays its direct letter shortcut. The legacy shortcuts remain active:

- Apps: `S` starts/stops, `R` restarts, `A` toggles autostart, `U` applies a
  routine update. Lifecycle/autostart commands do not appear for system apps.
- Updates: `C` starts a fleet check and `A` confirms all routine updates.
  Review-required updates remain read-only and are completed from normal Shell.
- Home: `R` refreshes the snapshot; `Enter` opens the latest alert. `U` opens
  Core-update confirmation only when `Update [U]` is visible.
- Device: select Theme, Sound, or Quiet hours and press `Enter` to cycle or
  toggle its value. Connection
  setup, Core actions, and Device actions are named rows in the same list.
- Direct Device shortcuts: `R` restarts Core, `U` updates Core, `O` installs
  firmware OTA, and `Delete` revokes the credential.
  Core and firmware operations require two Enter presses.

The Theme setting cycles between the dark Amber, Ocean, and Violet palettes.
Amber is the default. The selected palette and sound preferences persist
across restarts without changing Wi-Fi credentials or authorization.

Informational popups close with `Esc` (`Fn+\``), the bare backtick key,
`Enter`, `Backspace`, or `Q`. `Esc`/backtick and `N` cancel confirmation
popups.

Mutations are refused below 15% battery unless USB-C power is connected.
Firmware OTA requires 50% or USB-C power and a valid clock. The display stays
on until the physical power switch is used. There is no event stream, background
notification delivery, motion wake or standby mode. Legacy standby keys in NVS
are ignored; upgrading preserves Wi-Fi, the Core origin and the access token.

The first app snapshot appears before notifications and the cached Core update
verdict finish loading. Unloaded alerts show `...`; an unknown Core update
verdict shows `Update ?`. App update counts come from Core's existing checks:
booting the console does not launch a new fleet check. The Home footer always
shows snapshot age and Refresh. Attention includes configuration/permission
problems, restart requirements, failed update checks and unhealthy running apps.

Refresh is explicit. An operation started on the device gets a bounded follow-up
window (two minutes, at most one refresh every two seconds while requests are
idle). Settled app operations end follow-up early. After a minute without a fresh
snapshot the header says Stale; the last-known values remain visible. Core restart
uses an instance/source revision and a request ID, then checks its receipt. A lost
restart response is recovered with the same ID during the session, without
reissuing the POST. A Core update response is displayed as accepted, not completed.

Sequential reads share one validated HTTP connection; it is released after five
idle seconds and before firmware OTA. Startup logs report Wi-Fi readiness,
authorization, first app data, complete sync, request duration and heap. The
NTP startup jitter is at most 100 ms. Local HTTP does not wait for the clock;
HTTPS still waits and compares time against an explicit UTC build epoch.

## Build and flash

```bash
cd apps/shell-cardputer
tools/install-idf.sh
tools/idf.sh build
tools/idf.sh -p /dev/cu.usbmodemXXXX flash monitor
```

The first command installs the pinned ESP-IDF toolchain below this application
instead of modifying a global installation. USB device names vary by operating
system; `tools/idf.sh --list-targets` and `ls /dev/cu.*` are useful diagnostics
on macOS.

For the same hermetic build used in CI:

```bash
apps/shell-cardputer/tools/docker-build.sh
```

The 8 MB flash layout contains two 3.8125 MiB application slots. A full USB-C
flash writes the bootloader, partition table, initial OTA selector, and the
firmware image. If an OTA image cannot confirm healthy boot, ESP-IDF rollback
returns to the previous slot. Hold the device's download/reset controls and use
the full `flash` command above when both normal boot and OTA recovery are
unavailable.

CI and the rolling `cardputer-dev` release publish:

- `hosty-cardputer.bin` for OTA;
- bootloader, partition table, and initial OTA-selector images for recovery;
- `SHA256SUMS` and GitHub build-provenance attestations.

## Host verification

```bash
apps/shell-cardputer/tools/host-test.sh
apps/shell-cardputer/tools/render-harness.sh
```

The host suite includes the actual HTTP adapter through a deterministic ESP-IDF
seam, including persistent handles, per-request headers/body, failures, native
header-clearing behavior and Core restart recovery.

The render harness writes the four 240 x 135 views, Ocean/Violet theme samples,
a conditional Core-update indicator, and an action-menu sample under
`apps/shell-cardputer/build-host/render/` for review without a Cardputer.

## Troubleshooting

- A board-identification failure means the target is not Cardputer ADV; the
  original Cardputer and v1.1 are intentionally unsupported.
- Wi-Fi association retries automatically after transient startup failures; it
  does not require re-entering or re-saving valid credentials. Press `Enter`
  to retry immediately, or `F4` to edit credentials when the displayed reason
  says the network was not found or authentication failed.
- `Setting time` is a normal HTTPS startup phase. The firmware tries three NTP
  services and shows a technical failure popup only after repeated attempts.
  If it persists, confirm the access point permits UDP NTP. Local-network HTTP
  remains usable without time, but OTA and quiet hours still need a valid clock.
- `Administrator required` means a `host.user` approved the code. Deny/revoke
  that credential in Shell and approve the new code as `host.admin`.
- `stale` or `offline` keeps the last bounded snapshot visible but disables
  trustworthy current-state assumptions. Check Core reachability and Wi-Fi;
  press Home `R` after connectivity returns to fetch a fresh snapshot.
- `Release is older` is not an OTA failure: downgrade protection rejected the
  compiled-in rolling release. A same-version rolling development image may be
  reinstalled deliberately; a download or validation error leaves the current
  OTA slot selected.
- For a repeated boot failure, use the USB-C full-flash command. It rewrites
  the bootloader, partition table, OTA selector, and current image; NVS is a
  separate partition and is not erased by the normal flash layout.
