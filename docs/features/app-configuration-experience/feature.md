---
created: 2026-10-08
updated: 2026-10-08
summary: Default-only installation, shared configuration readiness and optional app-author guidance for manifest and app-owned settings.
components: [apps/core, apps/shell, apps/marketplace, packages/app-sdk]
---

# App Installation And Configuration Experience

## Default Installation

Shell and Marketplace choose the source before opening one Core confirmation. Marketplace uses the
feed's declared default when the user has not selected a channel; it does not assume stable. Core
reviews the exact selected manifest. The confirmation offers supported runtime, automatic startup
and permissions only. It contains no feed, settings, source or mount editor. Runtime changes renew
the review and nonce against frozen manifest bytes, without following a moving publisher head.
An unavailable default remains explicit until the operator selects an available alternative.

The default SDK dialog prepares and submits the selection immediately. App-local presentation
contains preparation, errors, status and a blocked-popup confirmation link. Callers reserve the
popup synchronously in the Install gesture before any asynchronous source request. Custom
CLI/API/SDK clients retain authorized installation configuration inputs.

Effective configuration uses generated Core values, manifest defaults and retained data. Retained
values override defaults, explicit caller values override retained values, and explicit empty strings
remain empty. Automatic startup defaults to enabled; an explicit preference overrides retained
configuration and otherwise the retained preference survives. The reviewed plan and Core confirmation
preselect that retained preference on reinstall. An omitted or null automatic-start submission keeps
that reviewed default; an explicit client or confirmation-checkbox choice overrides it. Changing
runtime renews the review without resetting the selected preference. The preference controls
install-time launch and Core boot, and is preserved while configuration is incomplete.

## Configuration Readiness

Core projects `configurationReadiness` on app summaries and MCP details. It evaluates required
plain and secret settings and the same resolved mounts/path checks used by startup. Diagnostics
contain setting keys, mount slot keys/labels and stable reasons; they omit secret values and host
paths. Unavailable shared configuration is reported as unverified and cannot authorize launch.
Mount readiness also checks declared cardinality: `multiple_not_allowed` means more than one
materialized path remains for a single-path slot. An update from multiple to single preserves the
bindings and keeps the target stopped; the operator keeps one binding and then uses Start.

Installation and approved updates register the selected version successfully even when required
configuration is incomplete. Core leaves the app stopped, without a doomed service launch. Shell
shows Configuration required beside the normal lifecycle state, with Configure opening the existing
app-settings dialog (Mounts when only mounts need attention). The warning contributes to the
Dashboard attention filter. Start and Restart remain server guarded and their UI controls are
disabled while Core reports known incompleteness. Saving configuration clears the warning when
requirements are met and does not start the app; the operator uses Start explicitly. Boot and
supervision skip predictably invalid launches rather than repeating them.

## Author Recommendations

These are recommendations, not manifest restrictions or mandatory migrations:

- Prefer defaults so installation works without a questionnaire.
- Keep installation-wide, infrequently changed inputs such as external service credentials and
  bootstrap paths in manifest settings.
- Use app-owned Settings for dynamic and user-specific preferences where the app has a UI.
  Prefer live reinitialization where practical, rather than requiring a process restart.
- Keep one authoritative owner for each setting; avoid duplicate values in Core and app storage.
- Headless apps retain the generic manifest/Core settings controls. They need no frontend,
  public origin or app-owned settings endpoint.

The generic Shell settings window remains available. Restart requirements alone do not determine
ownership. Authors choose the appropriate placement; this change introduces no three-tier settings
framework, automatic migration or app-to-Core restart notification protocol.

## First-Party Manifest Inventory

Inventory baseline is the manifests in this implementation branch. It records existing ownership,
not an approved settings migration. Every declared required setting in this repository has a default.

| App | Manifest configuration | Default readiness / author recommendation |
| --- | --- | --- |
| Shell | No app settings | Core generates runtime origin/port inputs. |
| Marketplace | Required catalog URL with default public catalog | Installs without input; catalog source is installation-wide. |
| Plans | No app settings | Installs without input; user preferences belong to its UI. |
| Harness | Transcript retention, default 30 days | Installs without input; its existing Settings UI owns provider connections and session choices. |
| Demo App | Greeting, channel, refresh interval, auth preview, all defaulted; optional catalog mounts | Demonstrates generic settings and an app-owned Settings page without forcing migration. |
| Telemetry | No manifest app settings | Runtime service environment and generated endpoint configuration remain separate. |
| Whisper | Required model, default small | Installs without input; current model changes require restart. |

Related owner-maintained repositories inspected on 2026-10-08 demonstrate why headless support and
post-install setup remain necessary: Media Server declares a required TMDb secret without a default
and required catalog mounts, Torrent Engine declares required downloads/VPN mounts and defaulted
engine/VPN parameters, Transcode Engine declares required media mounts with defaulted acceleration
and concurrency, and Project Manager has an app-owned Settings page without manifest settings.
Those repositories are unchanged. Media Server's existing Settings page and the headless engines'
generic controls remain their authors' choices.

## Testing Expectations

- Core covers defaults, retained values and explicit empty overrides, masked secret presence,
  required, invalid and over-cardinality mount bindings, stopped successful apply, later configuration/Start, boot
  skipping and supervision without retry loops.
- Core HTTP tests cover exact runtime/autostart/permission decisions, omitted/default/retained and
  explicit automatic-start choices through confirmation and apply, runtime re-review, frozen channel manifests,
  unavailable runtime choices, actor/nonce/Origin protections and escaped diagnostics.
- SDK, Shell and Marketplace tests cover direct default preparation, synchronous popup reservation,
  blocked popups, declared channel defaults, uncertain same-ID status recovery and custom clients.
- Browser acceptance uses normal-password authentication and Core-managed apps to verify the
  single confirmation, runtime/manual-start choices, an incomplete headless install, Configuration
  required → Configure → explicit Start and routine update.
