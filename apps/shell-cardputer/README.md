# Hosty Cardputer Operator Shell

Hosty Cardputer Shell is native firmware for **M5Stack Cardputer ADV**. It is
an administrator console for one Hosty Core host; it is not a Hosty runtime app
and cannot open runtime-app user interfaces.

The implementation is in progress. The firmware already builds for ESP32-S3,
but physical-device power, wake, notification, and rollback acceptance remains
open. Host-side protocol, state, power, and rendering tests do not require
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

`Fn+1` through `Fn+4` select Dashboard, Apps, Updates, and Device. Arrow keys
move the selected app. Available commands are deliberately limited:

- Apps: `S` starts/stops, `R` restarts, `A` toggles autostart, `U` applies a
  routine update, and `L` opens a bounded log tail. Lifecycle/autostart commands
  do not appear for system apps.
- Updates: `C` starts a fleet check and `A` confirms all routine updates.
  Review-required updates remain read-only and are completed from normal Shell.
- Device: `Enter` edits setup, `Delete` revokes the current Core credential and signs out, `R`
  restarts Core, `U` updates Core, `O` installs firmware OTA, and `D` enters
  deep standby. Core and firmware operations require two Enter presses.
- Device power: `M` toggles motion wake, `S` toggles sound, `Q` toggles the
  default 22:00-07:00 quiet-hours window, and `+`/`-` adjust screen timeout.

Mutations are refused below 15% battery unless USB-C power is connected.
Firmware OTA requires 50% or USB-C power and a valid clock. Online standby
keeps Wi-Fi/SSE active with the screen asleep; keyboard or threshold motion
wakes it. Deep standby disconnects Wi-Fi and therefore cannot receive live
notifications.

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

The render harness writes four 240 x 135 PPM images under
`apps/shell-cardputer/build-host/render/` for review without a Cardputer.

## Troubleshooting

- A board-identification failure means the target is not Cardputer ADV; the
  original Cardputer and v1.1 are intentionally unsupported.
- `Clock not set` blocks HTTPS and OTA. Confirm the access point permits UDP
  NTP, then retry. Local-network HTTP remains usable without time.
- `Administrator required` means a `host.user` approved the code. Deny/revoke
  that credential in Shell and approve the new code as `host.admin`.
- `stale` or `offline` keeps the last bounded snapshot visible but disables
  trustworthy current-state assumptions. Check Core reachability and Wi-Fi;
  reconnect performs a full resync before returning to `online`.
- `Release is older` is not an OTA failure: downgrade protection rejected the
  compiled-in rolling release. A same-version rolling development image may be
  reinstalled deliberately; a download or validation error leaves the current
  OTA slot selected.
- For a repeated boot failure, use the USB-C full-flash command. It rewrites
  the bootloader, partition table, OTA selector, and current image; NVS is a
  separate partition and is not erased by the normal flash layout.
