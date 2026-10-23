---
created: 2026-07-12
updated: 2026-10-22
summary: First-party apps are ordinary runtime apps selected from a distribution catalog during initialization and removable like any other.
components: [apps/core, apps/cli, apps/shell]
---

# Removable System Apps — Distribution Catalog and One Lifecycle

Hosty ships first-party apps (Shell, Marketplace, Harness, Telemetry) as ordinary runtime apps. They are
installed and uninstalled through the same lifecycle as any other app, from any surface: the Shell's
Installed Apps list, `hosty setup`, or `hosty apps remove`. The release's list of first-party apps is
a **catalog**, not a policy. [Hosty initialization](../hosty-initialization/feature.md) installs the first
explicit selection; completed initialization does not reconcile removed apps back into existence.

The implementation retains app-specific legacy bootstrap configuration and preference migrations;
these are recorded separately from runtime prerequisites in the
[Core boundary audit](../../reviews/2026-10-22-core-application-boundaries.md). The
[compatibility plan](plan.md) owns their remaining removal. Browser routing and UI-specific review
warnings are owned by [replaceable UI clients](../replaceable-ui-clients/plan.md).

## What "system" means

A manifest may declare `role: "system"`. That marker describes a platform app:

- Enabled administrators have implicit access; other users need an explicit assignment, just as for
  ordinary apps ([AppAccessPolicy](../../../apps/core/src/Haas.Hosty.Core/AppAccessPolicy.cs)).
- App access does not grant administrative operations. Core checks the user's role and the calling
  app's permissions independently.
- It gets its own session idle/absolute grant windows ([AuthLifetimes](../../../apps/core/src/Haas.Hosty.Core/AuthLifetimes.cs)).
- Its manifest UI block is validated strictly (explicit entrypoint, no path duplicates, no runtime
  endpoint guessing).

A system app carries **no lifecycle immunity**. `RemoveAsync` treats every app identically, and the
browser API and control plane behave the same. `System` is derived from the manifest at install and
update (escalation only, never a downgrade), and an install plan reports it so the review dialog can
surface the escalation before the operator confirms.

## The distribution catalog

`distribution-apps.0.1` lists the apps a release offers: id, title, description, `manifestRef`,
optional `feedsUrl`, and `defaultEnabled`. Core resolves it from, in order, the
`HOSTY_DISTRIBUTION_APPS_PATH` override, a `distribution-apps.json` found by walking up from the
working directory or the binary's directory (how a source tree wins with local refs), then the list
embedded in the binary. A broken list is loud but never fatal — problems are logged and surfaced
through the catalog endpoint, and Core stays usable.

Every entry in the embedded release list carries a `feedsUrl`, so a first-party app is feed-bound
from its first install: it updates through the normal reviewed plan/apply flow and can be reinstalled
from the same feed later. `manifestRef` remains the direct fallback. Each first-party app publishes
its own `feeds.json` (`app-feeds.0.1`) next to its manifest.

## First selection and legacy seeding

An initialization intent or state file suppresses the legacy seed pass before any application is
selected. Core owns resumable installation, readiness and completion for the explicit selection.
The distribution seed marker is recorded after the selection is ready. `hosty setup` remains the
ordinary catalog management surface after initialization.

Without initialization intent, the legacy source/installed-host path retains its seed behavior.
On start, Core checks whether this host has been seeded. A host counts as seeded when it carries the
seed marker `{dataRoot}/core/distribution-seed.json` (`distribution-seed.0.1`), the pre-seeding
`bootstrap-choices.json`, or **any** installed app at all — the last check is what adopts hosts that
predate seeding without reinstalling something they had removed.

A host that is not seeded installs every entry whose effective enablement is true (the deprecated
legacy env overrides still outrank `defaultEnabled` for one release) and then writes the marker. The
marker is written even when some of those installs failed — the first successful install already
makes the host count as seeded, so withholding it would buy no retry and only risk resurrecting an
app uninstalled in the meantime. What earns the retry is the marker's `pending` list, naming exactly
the entries still owed. A later boot retries those and nothing else, clearing each one that lands;
an entry that has since left the catalog is dropped rather than retried forever. Because an id
leaves the list the moment the app exists — installed by the retry, by `hosty setup`, or from the
Marketplace — and never returns to it, this can never reinstall something the operator removed.

After seeding, boot touches installed apps in exactly one way: it re-applies an ambient development
source override (`HOSTY_SHELL_SOURCE_OVERRIDE_PATH` and friends), which is a pointer to a developer's
own checkout and unset on every real host. Boot does not fetch manifests, advance versions, rewrite
update pointers, or stamp settings. Everything else about an installed app changes only through the
operator's own reviewed flows.

Consequences of the one-time model:

- An uninstalled app stays uninstalled. No tombstone or intent file is needed, because nothing
  reinstalls it.
- An app added to the catalog in a later release never appears by itself on an existing host; it
  shows up in `hosty setup` and Marketplace.
- Membership in the catalog is recorded as provenance only (`InstallOrigin: "distribution"`). It
  confers no privilege: whether a seeded app is a system app is decided by its manifest role, exactly
  as for any other install path.

## Removal impact

Before an uninstall, Core can report what it would affect
(`GET /api/apps/{appId}/remove-impact`, mirrored on the control plane). The answer is computed from
what other apps declare, never from per-app copy:

- **Dependents** — installed apps whose manifest declares a cross-app dependency on this one, with
  their run state and the `HOSTY_DEPENDENCY_{ALIAS}_URL` variables that stop resolving. A running
  dependent keeps its current values until it restarts, so the loss lands at its next start.
- **Capability consumers** — for each platform slot the app provides, the apps that consume it. An
  `otlp-collector` provider is consumed by every installed app with telemetry enabled; their exports
  fail harmlessly.

The preflight is advisory by contract: it returns facts, never a refusal, and an app nothing declares
against returns empty lists. Because both sources are structural, a third-party app that takes over a
first-party role is described exactly like the app it replaced.

## Surfaces

**Shell.** Dashboard and Manage retain removal for every app the administrator can manage, system
apps included. The Apps overview adds administrator-only Uninstall beside Open and Standalone.
Every removal entry opens Core's isolated review directly, without a preliminary Shell dialog.
Core shows computed impact, one Removal options checkbox section, a short runtime-state explanation
and the stop/removal warning. It does not repeat the choices in a static list. Removing the
active Shell carries its availability warning and the `hosty setup --with hosty.shell` recovery hint.
Shell retains blocked-popup fallback, original-request recovery and visible cancellation/failure;
only confirmed Core execution reports removal. Cleanup defaults, reviewed option changes and
source protection follow [trusted confirmation](../app-installation-sdk/feature.md#trusted-confirmation).
The install review shows the system escalation when a plan produces a system app. Core settings
and ingress remain separate; there is no Extensions enable/disable state.

**CLI.** `hosty setup` presents the catalog with the host's actual installed state; ticking an entry
installs it, unticking an installed entry uninstalls it. Both are real lifecycle operations against a
running Core (`--with`, `--without`, `--yes`, `--list`, `--delete-data`), so the command requires Core
to be running and says so plainly when it is not. Core owns the catalog, so manifest refs and feed
locations never reach the CLI: an install is `POST /control/v1/core/bootstrap/{appId}/install`, and an
uninstall is the ordinary app remove. Uninstalls keep app data unless `--delete-data` is passed.

**Marketplace.** Install and update only; removal is not its job.

## Endpoints

| Route | Surface | Purpose |
| --- | --- | --- |
| `GET /api/core/bootstrap` | admin session | Catalog entries plus live installed state and the seeded flag |
| `GET /control/v1/core/bootstrap` | control plane | The same snapshot for `hosty setup` |
| `POST /control/v1/core/bootstrap/{appId}/install` | control plane | Install one catalog entry by id and start it |
| `GET /api/apps/{appId}/remove-impact` | admin session | Advisory removal impact |
| `GET /control/v1/apps/{appId}/remove-impact` | control plane | The same, for the CLI |

Trusted operator and control-plane removal uses `POST /api/apps/{appId}/remove` (or its
control-plane twin), identical for every app. App callers such as Shell prepare a removal through
the [installation approval flow](../app-installation-sdk/feature.md#trusted-confirmation); app tokens
cannot invoke direct removal.

## Testing Expectations

- A fresh host seeds the release defaults exactly once and writes the seed marker; a seeded host
  installs nothing on a later boot, including after the operator removed a seeded app.
- Hosts carrying the legacy `bootstrap-choices.json`, or any installed app, are adopted as seeded
  without installing anything.
- A partial seed records the entries it could not install as `pending`; the next boot retries exactly
  those, clears the ones that land, and drops any that have left the catalog.
- Boot leaves an installed app's version, runtime, autostart, settings, and update pointer untouched,
  and performs no remote fetches.
- Removing a system app succeeds on the ordinary path, with no surface distinction. Shell's
  administrator-only Apps Uninstall and existing removal entries open Core review directly and
  retain cleanup choices, impact/runtime/Shell warnings, source protection and popup recovery.
- The impact preflight lists declared dependents (with `required` and aliases) and capability
  consumers, and returns empty lists for an app nothing declares against.
- `hosty setup` reflects live installed state, installs and uninstalls only where the selection
  differs, passes `--delete-data` through, and reports a missing Core with the `hosty core start`
  hint.
- A distribution entry whose manifest declares no role installs as an ordinary app, with provenance
  stamped and no system flag.
