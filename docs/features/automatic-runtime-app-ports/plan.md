# Automatic Runtime App Ports — Remaining Reservation Work

Status: Draft
Created: 2026-07-14
Updated: 2026-07-28

The install-time reservation model shipped across PRs #187–#191 (persistent model and boot migration,
coordinated allocation and adapter consumption, reassignment plan/apply with dependency impact,
start-time preflight, Shell reassignment UI), and operator port pinning shipped in #227. What that
built is described in [feature.md](feature.md); this document is what an audit on 2026-07-28 found
still missing.

The original plan was approved on 2026-07-14 and its checkboxes were never maintained — all 42 read
unchecked while most of the work had merged. The deliverables below are the audited remainder, so the
count is real. Status stays `Draft` because this is a re-scoping the owner has not yet approved in
this form; promote it to `Ready` to start.

## Goal

Close the gaps between the reservation model as designed and as shipped: make every lifecycle path
that can change an app's ports go through the allocator, produce the endpoint state the API already
declares, and stop silently accepting port input the model cannot honour.

## Target behavior

Written as a diff against [feature.md](feature.md).

- Update, runtime switch, and live-source contract adoption reserve newly declared ports under the
  allocation gate before the new contract commits, and release a reservation whose port key the
  reviewed change removed. Today all three carry assignments forward verbatim, so a new port key gets
  no reservation and a removed one is never released.
- An endpoint whose reserved port is held by another process reports `availability: "unavailable"`.
  Today Core only ever emits `assigned` or `running`, so the Shell surface built for `unavailable` —
  the endpoint marker, the app-level problem alert, and its tests — is unreachable.
- An app-scoped `HOSTY_PORT_{KEY}` override that maps to several independently published services,
  with no service-scoped override disambiguating them, fails with a clear validation error. Today it
  resolves for every matching service, handing the same port to each.
- `POST /api/apps/{appId}/configure` validates a `HOSTY_PORT_*` value and re-reserves, or rejects it
  and points at the reassign endpoint. Today it stores anything, and the record disagrees with the
  setting until the next install.
- Uninstalling with data retained records the automatic port as a non-binding reuse preference, and a
  reinstall takes it back only when it is free in both Hosty and the OS. Today the port is dropped —
  including an operator's pin, because `HOSTY_PORT_*` is not a manifest-declared setting and the
  retained-settings overlay projects over manifest keys only.
- Raw-L4 and host-network reservations participate in collision diagnostics on their own transport
  and bind scope: a `host`-scope port conflicts with a narrower assignment on the same transport and
  number, and a UDP declaration is reserved as UDP rather than recorded as TCP.
- A stopped app's endpoint URL is not presented as an openable link.

## Deliverables

- [ ] Reserve and release under the allocator in update apply, runtime switch apply, and live-source
      contract adoption.
- [ ] Produce `EndpointAvailability.Unavailable` from a reservation that fails its bind probe.
- [ ] Reject an ambiguous app-scoped `HOSTY_PORT_{KEY}` override with a structured validation error.
- [ ] Validate (or refuse) `HOSTY_PORT_*` on the configure path and keep the reservation in step.
- [ ] Retain the automatic port as a reuse preference across uninstall-with-data and reinstall.
- [ ] Extend the assignment model and probes to UDP and to bind-scope-aware collisions.
- [ ] Disable Open for an endpoint whose owning service is stopped.
- [ ] Cover the reassign dialog's extractable logic (manual-port bounds, request payload) with
      `node --test`, alongside the existing `app-problems` coverage.
- [ ] Document the reassign endpoints in [core-api.md](../core-api.md) and install-time reservation
      plus `HOSTY_PORT_{SERVICE}_{KEY}` in [local-development.md](../local-development.md).
- [ ] Validate a never-started app end to end against a live Core: install with start disabled,
      configure a public origin, first start, Core restart.

## Phases

### Phase 1 — Lifecycle coverage

- [ ] Update/switch/live-source reservation and release.
- [ ] Configure-path validation.
- [ ] Regression tests for a port key added and removed by each path.

### Phase 2 — Honest state

- [ ] `unavailable` producer.
- [ ] Ambiguous-override rejection.
- [ ] Stopped-endpoint Open disable.
- [ ] Retained-port preference.

### Phase 3 — Transport and scope

- [ ] UDP reservations and probe.
- [ ] Bind-scope-aware collision domain.

### Phase 4 — Documentation and verification

- [ ] `core-api.md` and `local-development.md`.
- [ ] Live end-to-end validation.

## Deliberately not doing

- **An `Assigned · App stopped` badge on the endpoint row.** Dropped with a written rationale
  ([port-reassign-control.tsx:18](../../../apps/shell/src/app/shell/pages/port-reassign-control.tsx)):
  `assigned` duplicates the endpoint URL block directly below it, and `running` duplicates the
  service status badge above it. Only the failure case earns a marker. Disabling Open while stopped
  is kept as a deliverable above — that one is a defect, not a design choice.
- **A component-test harness for Shell.** Shell has no jsdom/RTL/Playwright setup, and standing one
  up for a single dialog is an infrastructure decision that does not belong to this feature. The
  extractable logic is covered by the `node --test` deliverable instead.
- **A pre-allocated candidate port in the reassign plan.** The plan reports the current port and
  impact; the new port is chosen inside apply under the gate. Showing a candidate would mean holding
  or re-validating it across two requests for no operator benefit.
- **A configurable automatic port range.** OS ephemeral allocation remains the pool.

## Open questions

- Should an ambiguous app-scoped override fail the install, or resolve to the first service and warn?
  Failing is the original decision; it is a breaking change for any app already relying on the
  current fan-out behavior.

## Verification

- `npm run core:build`
- `npm run core:test`
- `npm run shell:lint`
- `npm run shell:test`
- `npm run shell:build`
- `npm run ci`
- `node scripts/docs-index.mjs --check`
- Core-managed Demo App install with start disabled; assigned endpoint visible before first start.
- Update an installed app with a manifest that adds and removes a port key; confirm the added key is
  reserved and the removed one released.
- Hold a stopped app's reserved port from an unrelated process; confirm the endpoint reports
  `unavailable` and Shell surfaces the problem before a start is attempted.

## Links

- [Automatic Runtime App Ports](feature.md) — the shipped reservation model.
- [Cross-App Dependencies](../cross-app-dependencies/feature.md) — consumes local endpoint URLs that
  a reassignment invalidates.
- [Raw L4 Ports](../raw-ports.md) — the UDP and `expose: host` declarations phase 3 must cover.
- [Host Networking](../host-networking.md) — fixed host-namespace ports.
- [Cloudflare Ingress](../cloudflare-ingress/feature.md) — consumer of install-time endpoint URLs.
