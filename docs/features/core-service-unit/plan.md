# Core Service Unit — Surviving A Reboot

Status: On Hold
Created: 2026-09-01
Updated: 2026-09-01

Parked by owner decision (2026-09-01), recorded so it is not lost.

## Goal

Give Core a boot-time startup story. Today's background start is a detached process (`nohup` on
Unix, a detached process on Windows) — nothing restarts Core after the host reboots. The expected
shape: `hosty setup` writes an OS service unit — launchd on macOS, systemd on Linux, a Windows
service — that runs Core, and the unit becomes the carrier of "sticky" launch parameters for the
installed instance.

## Open Questions

1. One supervisor per platform, or a common wrapper? Windows process management has cost this
   project before (Job Object kill-on-close, inherited log handles) — budget for platform-specific
   work.
2. Does `hosty core start` remain as the manual path alongside the unit, and how do the two avoid
   fighting over the same instance?
3. How does the update flow's restart interact with a supervising unit? The unit restarting what
   the update just stopped is the classic failure.

## Deliverables

- [ ] Design and per-platform decision recorded; then per-platform units, `hosty setup` wiring and
      docs — expanded when this leaves On Hold.

## Links

- [core-runtime-parameters](../core-runtime-parameters/feature.md) — the plan this was split out of;
  its launch-parameter model is what a unit would encode.
