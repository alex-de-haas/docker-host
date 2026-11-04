---
status: In Progress
created: 2026-07-10
updated: 2026-11-04
summary: Publish ready app and Core/CLI releases through daily and stable feeds, with verified artifact reuse, safe preparation and migration of existing update sources.
components: [apps, packages/app-sdk, .github, scripts]
---

# Ready Releases And Update Feeds

## Approval And Scope

The owner approved this scope in chat on 2026-11-03: publish complete app releases before offering
updates, retain Core protection, migrate existing main sources, use the storage/migration decisions
below, and separate checks, artifact builds and publication with verified digest reuse. The owner
also accepted app.0.2 and clarified the channel policy: merged main changes publish to daily after
validation; stable is selected manually after stabilization. This replaces the earlier single main
channel decision and adds D12. The owner then included Core/CLI in the same delivery and requested
that no-argument update follows the configured Core feed. D13-D15 cover native platform releases,
feed configuration/legacy migration and prepared platform updates. Use feed as the operator-facing
term; retain existing channel spellings as compatibility aliases. The owner also confirmed that
daily/stable are this distribution's policy, while publishers can configure any valid feed names
and one, two, three, ten or more feeds without changing Core. The owner authorized full implementation on 2026-11-03. Implementation is In Progress. On 2026-11-04 the owner authorized the test-only Shell source
permission, completion of verification, commits, one pull request and fixes until its full CI passes.
This does not authorize production migration, stable promotion or merge.

This plan retains D1, D3 and D6-D9 from runtime app update hardening and adds D10-D15. D2, D4 and D5
move, with their IDs intact, to [update recovery and compatibility](../runtime-app-update-recovery/plan.md).
Those IDs remain reserved here and are not completed, renumbered or silently dropped. Their unresolved
data rollback and compatibility questions do not block this approved release scope.

The generic contract covers first-party and third-party runtime apps. Repository adoption covers
Shell, Desktop, Documents, Marketplace, Harness, Telemetry, Demo App, Whisper and OPUS, including
their Docker and production source/native profiles. External repositories use the same contract and
publisher guidance through their own authorized workspaces. Core treats app IDs as opaque and needs
no Marketplace, Harness, GitHub or particular registry to follow a release feed.

Core and CLI join the same daily/stable policy as one platform release with the shared version in
`Directory.Build.props`; their native release format remains separate from runtime app manifests.
Each runtime app retains its own version and selected feed. A platform feed choice does not change
app feeds or require any distribution app. SDK packages and device-installed Swift/Cardputer clients
retain their existing publication channels. Source/native runtime apps retain their supported paths.
New credentials, catalog authoring, app-data rollback and app/Core version ranges have separate owners
below. This scope does not revive the parked proposal to merge Core and CLI into one executable.

## Current Gap And Goal

The current [update flow](feature.md) can read a moving `main` manifest before its referenced images
exist. Existing probes report an incomplete check but cannot distinguish pending publication from
a broken reference by tag absence alone. Separately, [CI selection](../ci-feedback-loop/feature.md)
uses checked components to select publishers: broad validation can unnecessarily rebuild images.

Platform publication currently overwrites the rolling cli-dev assets. The CLI's local product-channel
placeholder names a release tag; Core reads that saved tag, but no-argument `hosty update` selects
cli-dev again. A missing Core install also downloads the default tag independently. Update replaces
CLI first and stops Core before downloading its replacement, so a later failure can leave a partial
update or stopped Core. D13-D15 replace these behaviors with one selected immutable native release.

The target separates three facts: which checks validate the change, which artifacts need new bytes,
and which app or platform releases are complete and eligible for announcement. A source merge,
passing broad CI, successful artifact subset or new monorepo SHA is not by itself a release.

## Decisions

### Publisher-Defined Feeds — D3/D12/D13/D14

Feed identity and cardinality are generic for both app and platform indexes. Daily and stable are
the two feeds selected by this repository's distribution policy, not reserved names, an enum, a
mandatory pair or special lifecycle/authority classes in Core, CLI or shared clients. Another app
publisher or Core/CLI distribution can expose one, two, three, ten or more named feeds through its
own index and build configuration without a Core code change. Apply ordinary document-size and
identifier validation limits, not a two-feed business limit.

Preserve app-feeds.0.1 rules and use the same selection rules for hosty-platform-feeds.0.1: at least
one entry; nonempty unique opaque IDs, case-sensitive, at most 128 characters; at most one explicit
default. A sole entry is the effective default. Multiple entries without a default require explicit
selection; array order and familiar names never choose one. Entries reference ready immutable
releases. Neither the format nor the consumer requires an entry named daily, stable or main.

Render the returned feed list dynamically in settings, CLI listings and client selectors. Fresh
installation reads that publisher's declared/effective default; no-argument updates retain the
operator's saved choice. A missing saved feed is an error, not a reason to choose stable or the first
entry. This repository declares stable as its default and ships explicit legacy-to-daily migration
data. Those declarations, the two-feed bootstrap and the cli-dev bridge below apply only to matching
distribution sources, not to every publisher or a source with coincidentally identical feed names.

Reusable publication logic takes a target and feed ID and validates them against publisher-owned
configuration. That configuration determines which trusted events can advance each feed, required
checks and whether manual promotion is required. The stock configuration maps main CI to daily and
manual promotion to stable; another publisher may use edge/beta/lts, one production feed or another
policy. Do not allow a caller to bypass configured promotion requirements by supplying a different
name. Core consumes the declared release and checks local readiness; it does not infer publication
policy, stability, version ordering or extra privileges from a feed's name. Artifact integrity and
availability checks apply equally to every feed.

### Release Storage And Identity — D3

Keep Docker images in their existing registry (GHCR for this repository). Store generated metadata
on a dedicated `app-releases` branch in each repository, shared by apps in a monorepo. This repository
also stores its platform feed/release metadata on that same branch under `platform/` (D13):

```text
apps/<app-id>/
  feeds.json
  releases/<release-id>/
    manifest.json
    release.json
  promotions/<promotion-id>.json
```

The branch contains generated metadata only. Source manifests stay in `main`. No publication commit
updates source version files or retriggers source builds; explicitly restrict workflow triggers to
source branches rather than relying solely on a bot token suppressing recursive events.

Published manifests retain their source-tree location in optional `source.manifestPath` (a contained
repository-relative path ending in `manifest.json`), because the generated metadata URL is not a
source directory. Manifest-relative assets and complete app skill packages are retained beside the
immutable manifest and included in its release identity.

Keep `app-feeds.0.1`. This repository's canonical feed URL is the HTTPS raw-file URL to this branch's
per-app `feeds.json`, containing `daily` and `stable`; `stable` is its explicit new-install default.
Both entries point to complete immutable releases and can point to the same release. Channels are
data entries, not Git branches: one metadata branch serves both and no permanent source branch per
channel is required. Their publication policy is defined in D12 below. Core continues to treat feed
IDs as opaque; these names/defaults are publisher and distribution data, not Core policy.

The old feed ID `main` is mapped to `daily` during reviewed source migration, not retained as a third
canonical channel or interpreted as a built-in alias by Core. Existing raw source URLs remain legacy
inputs until that installation migrates.

The feed's `manifestRef` names the full metadata commit SHA and immutable manifest path. `release.json`
records schema version `app-release.0.1`, app ID/version, candidate source commit, manifest digest,
selected production profiles and per-service artifacts: repository/digest/platforms or source pin,
build-input fingerprint and its format, original build source revision and provenance reference.
Publisher execution/retry IDs are separate evidence. Keep the first immutable completion record
unchanged on later attempts and append retry evidence outside the release directory. Core does not
need to query a CI provider.

Compute `release-id` as SHA-256 of the canonical release descriptor: normalized manifest plus the
ordered artifact/source identities and input fingerprints. Keep timestamps, publisher run IDs,
metadata commit SHA, channel membership and the release ID itself outside that hash to avoid
self-reference and make retries idempotent. Promoting an existing release changes neither its ID,
manifest, application version nor artifact bytes. Record source provenance without rewriting an
artifact's original build commit.
A same-version dependency rebuild can create a different release; a new unrelated source SHA alone
must not create a release or advance production source pins.

Publish in two durable steps after all required validation and artifacts succeed:

1. Append the immutable release directory, then verify its exact commit-pinned URLs and referenced
   artifacts through the intended consumer access. Existing paths must match byte-for-byte on retry.
2. Commit the app's feed pointer to that immutable manifest. Advance the branch with a normal
   fast-forward update against the observed head. On a concurrent publication, reload the branch,
   recheck eligibility and recreate only this app's change; never force-push or overwrite other apps.

Serialize/check promotion for each app/channel; the shared metadata branch also needs conflict-safe
head updates. A reader sees the previous complete release or the new complete release. An interruption
after step 1 leaves an unannounced release; after an uncertain step 2 response, inspect the same
release and pointer before retrying. Older cached feed responses remain valid complete releases.

Order eligibility against the last promoted release of the target app/channel and validated source
ancestry/input evidence, not equality with today's monorepo `main` tip or the other channel's head.
Older runs cannot move a channel backwards; unrelated newer commits cannot strand a completed
release. A stable candidate may be older than the current daily head while advancing stable.
Divergence or regression requires explicit recovery, outside normal promotion. Retain all
published release records and referenced image digests: no automatic published-release deletion in
this scope. Existing retention for unpublished temporary CI artifacts remains separate.

### Daily And Stable Publication Policy — D12

Use two channels for every adopted repository runtime app:

| Channel | Trigger and qualification | Pointer change |
| --- | --- | --- |
| `daily` | Successful required CI for the exact trusted push/merge revision on source `main`, then complete artifact/release validation. | Automatic, only when the app's effective release changed or a pending eligible publication is recovered. |
| `stable` | An operator selects a completed release after a stabilization period and manually dispatches promotion. | Only the selected exact release, after revalidation and a guarded pointer update. |

Daily names the frequent development stream, not a once-a-day schedule or a stability guarantee.
An open/updated PR runs validation and any required test builds; it cannot advance either public
channel. A merged PR enters daily through its successful main push CI. Failed, cancelled, unmerged
or fork PR runs cannot authorize release publication. Docs-only/no-op changes need no new app release.
Keep artifact availability, schema validity and supported-platform checks mandatory for both channels;
manual promotion cannot waive them. Passing CI qualifies a daily candidate, not a stable decision.

Implement a shared publication/promotion routine with separate automatic-daily and manual-stable
entry points. The automatic entry point can update only daily. The manual `workflow_dispatch`
entry point accepts an app ID, exact completed `release-id`, expected current stable release (or
explicit first publication) and a stabilization note/evidence reference. Resolve no mutable `latest`,
branch head or current daily pointer in place of that selection. Verify the app, immutable manifest,
artifact identities/platforms, original successful checks and current consumer availability before
changing stable. A selected retained daily release stays selectable after daily has advanced.

Stabilization fixes still follow normal PR/main checks and create new daily candidates. The operator
chooses the final tested candidate when stabilization is complete; elapsed days or weeks do not
automatically promote it. Stable promotion reuses that candidate's exact manifest, image digests and
source pins. It does not rebuild images, change embedded versions or add/remove prerelease suffixes.
If bytes or version must change, qualify a new candidate first. App semantic versions retain the
repository's existing per-artifact rules; channel membership is separate release metadata.

Record a promotion ID, app/channel, previous and selected release, actor and time in an append-only
promotion record committed with the feed pointer; stable decisions also include the stabilization
evidence. Preserve original build provenance. Repeated promotion to the same release is a no-op/recovered success; a stale expected
pointer requires a new selection rather than overwriting another promotion. Daily publication and
stable promotion must preserve each other's entries when rebasing metadata-branch updates. Neither
channel can move the other. A failed stable promotion changes no pointer; an independently
concurrent successful daily publication can still advance daily.

Bootstrap each app explicitly: generate and verify its first daily candidate, then manually approve
an initial stable release before exposing the canonical two-entry feed or changing install defaults.
Before that, candidates can be tested through their immutable manifest URLs; source migration for
that app waits. Never fabricate stable approval, publish a dangling stable entry or expose a sole
daily canonical feed as if it had no default: app-feeds.0.1 treats a sole entry as the effective
default. Once seeded, fresh installs use stable, and daily remains an explicit choice. Distribution
and catalog fallbacks pin a verified stable manifest and never fall through to daily or moving main.

Choosing another channel changes only the future update source. If switching from daily to stable
would select an older release, retain the installed build and apply the no-downgrade/review rules in
D8; selecting stable does not itself roll back binaries or data. Selecting a channel whose pointer
already names the installed exact release does not create an artificial update offer.

### Three Independent Selections — D10

Persist separately inspectable, exact-source-bound decisions for:

- **Checks:** behavior tests, integration contracts, lint and safety checks. Broad checks can remain
  conservative and include every component without ordering every publisher to build.
- **Artifact builds:** image/source inputs that actually changed. A component check is not a build
  request. A changed test or documentation file does not rebuild an image unless it is genuinely
  consumed by that artifact's build/setup process.
- **Release publication:** apps whose effective released manifest, production source/setup or artifact
  set changed, plus recovery of a previously eligible unpublished release. If none changed, do not
  emit a new release or advance daily merely because validation ran or the monorepo advanced.
  Manual promotion can independently advance stable to an existing release without new builds or a
  new release record; its subscribers receive an offer only when their effective installed release
  differs, including relevant manifest changes. Channel membership alone is not an artifact change.

Use an explicit per-artifact dependency/input graph. Include app sources, imported shared packages,
Dockerfile and effective context, `.dockerignore`, build scripts/configuration, toolchain versions,
build arguments affecting output, base-image digests, target platforms and resolved dependencies.
Recognize documentation, branding generators/assets and workflow paths explicitly. Unknown inputs
retain a documented conservative affected-build fallback; do not infer irrelevance just because no
dependency edge exists. Log the precise path/dependency/fingerprint reason for each decision.

Root `package.json`, lockfiles and toolchain changes need content-aware treatment. Distinguish
non-build metadata changes from commands/configuration that affect an artifact. Resolve each
workspace's transitive dependency closure including relevant hoisting/peer dependencies. A pruned
lockfile/context is safe only when the actual builder consumes that same projection. Until equivalence
is established, retain the full shared input and rebuild its affected consumers. Never simply ignore
lockfiles or narrow selection while Docker still copies broader inputs.

Narrow Docker contexts and broad `COPY . .` where necessary to the declared complete input closure;
otherwise unrelated files remain real build inputs and invalidate reuse. Include these changes and
their equivalence checks in D10. Cache reuse inside an already-started Docker build is distinct from
skipping that build entirely. Shared SDK/dependency changes still rebuild every actual consumer.

Keep the exact successful-CI gate and artifact-specific production validation. Publishers consume
trusted build/publication selections, not the test component list. Manual validation of all components
does not implicitly force all builds; forced rebuild/recovery is explicit and recorded. Recovery
compares candidate inputs with retained build/release evidence, including changes missed by a failed
or cancelled earlier publish, rather than inspecting only the latest commit diff.

### Reuse Unchanged Artifacts By Digest — D11

Before invoking a builder, compute a versioned canonical fingerprint of its complete effective inputs,
including file content/path/mode, symlink targets and deletions, resolved external inputs, platform
and build recipe. Unpinned network/setup inputs must be made reproducible or classified as unprovable;
a matching local-tree hash alone cannot authorize reuse.
Keep monorepo HEAD and current publisher timestamps out unless the application actually consumes them
as build inputs. Provenance labels describe the build that produced the bytes, not the current release.

Reuse only a retained successful artifact whose fingerprint and supported platform set match and
whose digest, availability and original provenance can be verified. Never reuse based solely on a
version number, short SHA tag, changed-path guess or Docker cache hit. Missing evidence, an older
fingerprint format, unresolved inputs or missing artifacts require a rebuild or an explicit failure,
never an optimistic reuse. Do not enable emulation to make a reused artifact appear compatible.

A release can intentionally combine newly built and reused service artifacts. For a Telemetry UI-only
change, rebuild UI and reuse the backend digest after proving its inputs unchanged; still verify the
referenced collector and test the resulting app combination. The completion record retains each
artifact's actual build revision and records validation against the candidate release separately.
Source/native profiles can retain an earlier production source pin only with equivalent complete
setup/runtime input evidence; they otherwise require new source qualification.

Manifest/version or feed changes can publish new metadata without rebuilding unchanged images.
If an app embeds its version in its binary/runtime, that version is a build input and requires a build.
Production locks always use digests. Preserve existing immutable version tags; add version aliases
for Shell/Demo App without overwriting an existing tag. A new version alias may reference a verified
reused digest without inventing new build provenance. Same-version rebuilds get distinct immutable
artifact/release identities while the existing version tag stays unchanged.

### Complete Release And Manifest Contract — D3/D6

Add `app.0.2` with an explicit digest-pinned Docker image object (`repository` and `digest`), strict
digest validation and supported platform verification. Do not accept a tag as an implicit substitute
for a declared digest. Keep reading `app.0.1` for legacy/direct installations. The current parser
ignores manifest digest fields, so publishing such fields under `app.0.1` would falsely imply protection.
Source releases use the supported full `source.commit` pin and qualify fetch/setup/runtime inputs.
The general Core version-range design remains in the separate Draft; schema support is the explicit
compatibility gate for this release contract.

For one app, verify every required production runtime artifact, whether freshly built or reused,
before promotion. Telemetry needs backend, UI and collector; Harness needs app/worker images and
its production source profile. Source/native apps require their supported tests, not Docker images.
Development-only workspace recipes do not block a production release. Third-party artifacts are
verified, not rebuilt by Hosty. Each app promotes independently after required CI; another app's
publication failure cannot hold an already-complete app release.

Seed initial releases using verified existing artifacts where evidence permits; do not force a full
rebuild merely to create release metadata or migrate sources. Validate icons, setup resources and
other relative references at their published location; required production inputs must not drift
through `main`. Published manifests and referenced artifacts remain independently inspectable.

### Core Readiness And Apply — D7/D1

Core checks the manifest, source and selected runtime's exact artifacts using existing authorized
host access. A publisher receipt does not replace local validation. Preserve bounded requests and
credential boundaries; repository credentials do not implicitly authorize registry access.

| Observation | Core/client behavior |
| --- | --- |
| Channel remains at the installed release during another build | No new offer or publication-wait warning. |
| New complete, accessible and supported release | Offer the exact reviewed revisions. |
| Missing digest, digest mismatch or unsupported platform | Artifact failure; no actionable or bulk update for that candidate. |
| Malformed manifest, wrong app ID or unsupported schema | Validation/compatibility error, not pending publication. |
| Access denial | Explicit access diagnostic. |
| Timeout, rate limit or unavailable source | Check incomplete, retry guidance and last successful check time. |
| Ambiguous response, including access-masked not-found | Preserve uncertainty instead of inventing a cause. |

Preserve prior successful evidence as history, but require successful revalidation before an
unconfirmed candidate is actionable. Keep failures in details/fleet diagnostics; hiding unavailable
offers must not imply that the app is up to date. Shell, Marketplace, shared SDK UI, CLI and MCP use
the same Core verdict rather than inferring readiness from version differences. Core never queries
GitHub Actions to guess whether a tag is still building.

Apply prepares/materializes the exact reviewed artifacts before stopping any app, including unrelated
third-party IDs. Lost access or image removal after planning leaves the working version running.
Feed/tag movement cannot substitute different bytes after approval. This does not promise automatic
rollback after a newly started app has modified data; that is D2 in the separate recovery plan.

### Source Migration Contract — D8

Introduce a generic `app-source-migrations.0.1` declaration supplied as reviewed distribution data:
`migrationId`, `appId`, exact `from` binding (`manifestUrl`, or `feedsUrl` plus `feedId`), and `to`
binding (`feedsUrl`, `feedId`). This repository ships its explicit mappings with the Core distribution;
Core code contains no first-party IDs, repository/path heuristics or publisher special cases.
External publishers can supply the same reviewable mapping or an operator can select a destination
explicitly. An untrusted mapping is a proposal, never authorization or proof of publisher ownership.

Add plan/apply for changing the whole update-source binding, not just the selected channel inside
an existing feed. Proposed API routes are `POST /api/apps/{appId}/update-source/plan` and `/apply`,
with retained operation lookup by request ID and equivalent authorized CLI/MCP operations. Planning
returns the old/new binding, expected installation/source revision, validated destination identity,
manifest/feed digests, impact and plan digest. Apply requires that exact plan and a stable UUID,
current source-management authority and the normal administrator review. A batch can review and
approve all selected mappings once while retaining independent per-app results and replay safety.
Previously granted authority applies only where it explicitly covers the exact switch.

Before changing a binding, seed a complete destination release and validate it through consumer
access. Match the exact current binding, verify app identity, expose any publisher/source change and
reject a stale plan if the operator changed sources meanwhile. Retain the previous binding and
durable operation result. Under the app lock, update only the future source binding, invalidate old
update plans/verdicts and calculate a new review; never install/apply that review as a side effect.

Migrate old feed URLs and direct `main` manifest URLs to the canonical `app-releases` feed while
explicitly mapping the old `main` channel/direct source to `daily`. The review displays this change
and explains that daily retains the frequent main-based update cadence; it never silently opts an
existing installation into stable. Preserve installed version, runtime, artifact/source locks,
permissions, settings, ports, users, data and autostart. No reinstall or restart is needed. Forks, private/custom
sources, explicit commit pins, local folders, source overrides, live workspaces and explicit
development channels are excluded from suggested batch migration; an intentional operator switch
uses ordinary review. An app ID or URL containing `main` alone never establishes eligibility.

On destination/access failure leave the old binding intact. If the installed build is ahead, keep it
and await an eligible release; never automatically downgrade. Compare known release/source ordering
and exact identities, not only semantic versions; unknown ordering is reported for review. Returning
to a previous source is another binding-only operation and never restores app data or binaries.

Roll out Core support for `app.0.2` and migration first, seed/verify both channels including the
initial manual stable promotion, then offer legacy-to-daily migration and change new-install
catalog/distribution defaults to stable per app. Update both feed and direct fallback defaults so
a failed feed cannot silently fall back to a moving source manifest. Do not rewrite/redirect old raw
GitHub URLs: old Core installations retain their previous behavior until upgraded/migrated, and old
`app.0.1` remains readable. No transparent correction of old clients is claimed. Keep legacy source
URLs available, but never use them as fallback after a confirmed ready-channel migration.

Retain migration declarations while the distribution supports the legacy source shape. Retirement
requires an explicitly documented compatibility cutoff and an operator-accessible manual source
switch; elapsed time or lack of telemetry is not evidence that every installation migrated.

### Platform Release Storage And Publication — D13

Extend the same checks/build/publication separation and daily/manual-stable policy to Core and CLI.
They remain two executables with one platform version, one selected feed and one coherent release.
No app.0.2 manifest describes them; ordinary app APIs cannot mutate the platform-owned hosty:core
resource. Reuse publication primitives without requiring a runtime app or imposing a platform feed
choice on installed apps.

Store platform metadata beside app metadata on the existing app-releases branch:

```text
platform/
  feeds.json
  releases/<release-id>/release.json
  promotions/<promotion-id>.json
```

Use `hosty-platform-feeds.0.1` for the generated index, with a list of publisher-defined feed entries
and a releaseRef plus descriptor SHA256 per entry. This repository emits daily/stable with stable
as the explicit default; the parser and resolver accept other valid names/counts/defaults. Each
releaseRef points to a full metadata commit SHA. The descriptor uses `hosty-platform-release.0.1`: release ID, shared version,
qualified full source revision, and the complete supported target matrix. Each CLI/Core asset has
its role, RID, filename, immutable URL, byte size, SHA256, build-input fingerprint and original
provenance reference. Retain VERSION and SHA256SUMS for tooling and the bridge, but take the new
client's expected asset hashes/version from its frozen descriptor. Validate roles, duplicate entries,
supported targets and consistency rather than inferring filenames from an unverified version string.

Keep native binaries in GitHub Releases. Publish each verified bundle under a write-once tag such
as `platform-v<version>-<release-id>`, never replace assets or move that tag, and fail a retry whose
existing bytes differ. Compute release identity from the canonical version/qualification/artifact
identities and build inputs; exclude channel membership, timestamps, workflow run IDs, locators that
contain the release ID, the metadata commit SHA and the ID itself to avoid self-reference. Compute
the descriptor hash after its final URLs are populated. Availability/deletion remains a checked
condition; a tag name alone is not immutability evidence.

This distribution requires both executables for every currently supported native target:
osx-arm64, linux-arm64, linux-x64 and win-x64. Publish no platform feed pointer until all eight assets, hashes and retained
source-bound provenance have passed validation and are accessible through intended consumer access.
Missing one target blocks this platform release, not unrelated complete app releases. Keep macOS
Intel unsupported. Retain every promoted platform descriptor and its assets under the same no-GC
policy as app releases. Hashes bind bytes to the trusted descriptor; they are not by themselves
proof of publisher authenticity. Preserve the existing provenance production/verification boundary.
A different publisher declares its supported target matrix; the generic consumer validates the
required CLI/Core pair for its host against that declaration, not a hard-coded vendor matrix.

Extend D10/D11 fingerprints to native inputs: project/reference closures, shared launch/contracts,
Directory.Build.props/version, SDK/AOT toolchain, resolved NuGet dependencies, RID, native libraries,
build scripts/arguments and any embedded revision. Reuse a native asset only on complete input
equivalence and verified hash/provenance. Shared version changes normally rebuild both families;
an embedded new source SHA is a changed input. Do not strip provenance or claim an unchanged CLI
can always be reused after a Core version bump. Select a new native source candidate only for
effective platform source/configuration/dependency changes or genuinely pending publication. An
unrelated app/docs-only commit retains the previous platform release and its qualified source; it
does not assign a new embedded revision just to create work. Once a new native candidate is selected,
its actual embedded revision/version participate in the full fingerprint and can require both builds.

Add platform as an explicit target kind to the shared promotion routine. Automatic successful main
CI may publish daily; stable requires manual selection of an exact completed platform release and
stabilization evidence, with the same expected-pointer guards, idempotency and audit records as D12.
Promotion reuses all existing binaries and does not rebuild, relabel source provenance or change
the shared version. Publish assets, then immutable metadata, then the feed pointer. Resolve branch
conflicts while preserving unrelated app/platform feeds. Normal feed-based clients download only
immutable release assets; cli-dev remains an explicit legacy bridge/pin, never an implicit fallback.

### Platform Feed Selection, Installation And Migration — D14

Use Feed in Core settings, CLI help and update status. Core and CLI share the selected platform
source per data root. Persist the index reference and feed ID, with a source revision, in a versioned
`core/update-source.json`; do not freeze a followed feed to whatever release it contained when saved.
Installed release receipts and accepted update operations separately retain exact descriptor/asset
identities. Explicit immutable release pins remain pins rather than being converted to feeds.

The resolution order is an explicit requested feed/index, the saved binding, a verified legacy-source
migration, then the publisher-declared/effective default for a genuinely new installation. This
distribution's default is stable after its first manual seed; its legacy cli-dev/main users migrate
to daily. A changed
index default never switches an existing selected feed. Missing/invalid selected feeds, failed access
or unsupported metadata report an error; no fallback to cli-dev, daily, another index or current-main
files. Keep custom repositories, explicit tags/pins and operator-provided index choices unchanged
unless explicitly selected for migration. No source can be recognized by its feed ID alone.

`hosty update` with no feed flag reads the persisted selection and resolves it once. Add canonical
`--feed` and `--list-feeds`; retain `--channel` and `--list-channels` as compatible aliases with
equivalent validation and no hidden default. Conflicting feed/channel arguments are usage errors.
Keep `--index` for an explicitly selected local file or bounded HTTPS index. Production defaults use
the generated remote index, not a placeholder discovered by walking the caller's current directory.
An explicit `hosty update --feed <id>` validates and persists that deliberate source selection before
running the normal update; a download failure does not undo the user's separately recorded choice.

Expose read/list and reviewed source-change operations through Core's supported admin API and CLI;
use a source revision to reject stale writes. Provide `hosty core feed` to inspect and
`hosty core feed <id> [--index <reference>]` to select without updating. Core's settings surface and
independent clients use that same contract. Selection resolves and validates the destination, saves
only the future source and invalidates previous offers/plans: no executable replacement, restart or
app-source changes. The CLI uses the same storage/locking rules when Core is stopped. Authority to
read a feed does not confer permission to change hosty:core or perform its lifecycle operations.

Core's update checker, its supported update action, CLI updates, bootstrap scripts and missing-Core
installation use the same resolver contract. Update status names selected feed, exact release,
installed/available version and structured readiness/error; stale successful evidence is historical,
not permission to apply an unconfirmed candidate. Apply must use the reviewed or accepted frozen
release, even if the feed advances afterwards. A Core UI action passes that selection to the CLI
instead of launching an unqualified update that independently chooses a different release.

Update Unix/PowerShell installers with `--feed`/`-Feed` and a common HOSTY_INSTALL_FEED override.
Resolve the feed once, verify the selected CLI artifact and persist a bootstrap receipt containing
the selected index/feed and exact platform descriptor. Fresh installs use the publisher's declared
default (stable for this distribution); an explicit feed choice remains selected. Initial `hosty start` downloads the Core paired with that receipt's CLI,
even if daily moved in between, before subsequent ordinary updates can advance the pair. Preserve
an explicit repository override when resolving the corresponding index; explicit tags remain
legacy/custom pins. Reject an ambiguous feed-plus-tag request.
An unavailable/unseeded stable fails before replacing files rather than silently installing daily.

Use an explicit bridge rollout for old clients: publish the first reader-capable Core/CLI bundle
through cli-dev using the same verified bytes, then freeze that tag/assets at the bridge release.
Never keep overwriting cli-dev after the cutoff. Old clients can install that bridge with their
existing commands; its next normal invocation recognizes only the known official default or exact
legacy main/cli-dev binding and records a visible, idempotent daily-source migration. If there is no
trustworthy legacy provenance or the destination is unavailable, leave its configuration intact and
request an explicit choice/report the failure. New installer receipts distinguish fresh stable
installs from legacy installs with absent configuration. Record the bridge identity and cutoff in
distribution data and operator documentation; do not infer migration completion from elapsed time.
Retain bridge assets for old clients and explicit pins. Old clients have their old download behavior
during the one-time bridge publication; the new frozen-release guarantees start with the new reader.

Import known legacy product-channel.json records through this same migration, preserving a backup
and a durable result. Do not retain two competing active selection files or silently reinterpret
custom records. Keep the unversioned legacy product index readable when explicitly supplied, and
snapshot its selected tag/checksum set once before staging both local native assets. Missing pair
entries or hash changes fail preparation; legacy metadata does not acquire the new descriptor
guarantees by being imported. Legacy ShellManifestPath does not control platform updates or change
app sources.
Selecting stable while daily is ahead keeps the installed binaries and reports that no eligible
forward update exists; unknown ordering remains explicit. Neither a different hash nor a lower
version is enough to authorize a downgrade. Feed selection itself never performs rollback.

### Prepared Core/CLI Update And Recovery — D15

Resolve one descriptor for the selected instance and stage both target-native executables before
replacing either executable or stopping Core. Validate hashes, sizes, RID, role, shared version,
source/release identity, usable files and install-path writability. Unchanged local binaries may
satisfy staging only after their exact hashes are checked. A missing/corrupt CLI or Core asset,
network loss or failed preparation leaves both installed binaries and the running Core unchanged.
Download no replacement from a moving feed after preparation. Reject stale source/installation or
live-launch revisions before the stop/replace boundary.

Extend the existing launch lock and supported CLI/Core operation path with a durable request ID,
frozen descriptor, staged paths/hashes, prior receipts, factual launch mode and per-step outcomes.
The Core action and CLI observe/resume the same accepted operation after a lost response or crash;
do not select a newer daily release during recovery. Serialize shared CLI executable replacement as
well as the selected data root. Separate roots keep independent feed/Core state; never update a
sibling Core or claim the shared CLI swap updated every instance. Report those exact paths/scope.

Use the supported keep-apps stop, platform-aware executable replacement and prepared restart flow.
An unconfirmed stop must not replace binaries. A deliberately stopped Core remains stopped. A
source/dev Core continues running its factual project; only its installed release artifacts update,
and the result distinguishes that from replacing the active process. Preserve application containers,
supported local runners, operator source/workspaces, permissions and ordinary data.

Two file replacements and a process restart are not one atomic filesystem transaction. Retain the
previous binaries/receipts and a resumable journal; partial replacements are an incomplete operation,
not success. Restore the prior binary pair on a recoverable pre-launch replacement failure, or retain
an explicit repair state if restoration fails. Once a target Core has started and may have migrated
data, do not automatically roll back binaries or data: retain evidence and provide explicit recovery.
Verify target process-start identity, expected release/mode and readiness before reporting a running
Core update complete; a stopped/dev instance has a distinct installed-only completion result. A failed
restart/readiness returns a failed or recovery-required result, not just a warning with exit zero.
This is executable preparation/recovery, not the deferred app-data rollback/compatibility design.

## Ownership And Interactions

- [App feeds](../app-feeds/feature.md) supplies the unchanged feed format; this plan owns full binding
  migration and release-channel semantics, including daily/stable publication and explicit defaults.
  Its sole-feed implicit-default rule is preserved by the two-channel bootstrap. Marketplace remains
  optional.
- [Repository release model](../repository-release-model/feature.md) and
  [CI feedback loop](../ci-feedback-loop/feature.md) retain versioning, required CI and provenance.
  D10/D11 explicitly change build/publication selection and reuse, including affected Docker contexts.
  D12 maps successful runtime-app main publications to daily and adds manual stable promotion.
  D13-D15 extend this to native Core/CLI bundles, the generated platform feed, installer bootstrap,
  saved-source resolution and prepared updates. SDK/device-client publication stays independent.
- [App publication](../app-publication/plan.md) composes this release contract in authoring/provider/
  catalog UX; it does not duplicate readiness or migration deliverables.
- [Runtime artifact extensions](../runtime-artifact-model/plan.md) retains new prebuilt delivery,
  per-runtime offers and durable platform/emulation locks. This plan's image schema and availability
  checks use existing execution capabilities and never silently enable emulation.
- [Core development mode](../core-dev-target/feature.md) retains factual launch/source selection,
  keep-apps behavior and restart ownership. D15 composes those controls and preserves live dev Core.
- [Local browser origins](../local-browser-origins/plan.md) retains its unresolved C3 coordinated
  Core/system-app upgrade decision. This plan coordinates Core and CLI only; a common feed name is
  not proof of app compatibility and does not authorize an automatic Shell/other-app update.
- [Core single binary](../core-single-binary/plan.md) stays On Hold; D13-D15 keep two executables.
- [Private distribution access](../private-distribution-access/plan.md) owns new credential grants.
- [Update recovery and compatibility](../runtime-app-update-recovery/plan.md) owns transferred
  D2/D4/D5. Staged preparation stays here and does not implement their unresolved data policy.

## Deliverables

- [x] D1. Stage/materialize the exact reviewed artifacts before stopping any app; preparation
      failures, including after a successful check, preserve the working runtime.
- [x] D3. Implement complete release identity/storage, two-step atomic channel promotion, retention,
      app.0.2 digest pins with app.0.1 support, source pins and unchanged-version releases; preserve
      publisher-defined feed names, counts and defaults.
- [ ] D6. Adopt the release contract for all nine repository runtime apps and production profiles,
      seed verified daily and manually approved stable releases, recover missed publication, and
      update install/catalog/distribution defaults to stable. Supply reusable publisher guidance and an
      external-app adoption inventory with explicit repository ownership/dependencies; never claim
      external adoption without evidence.
- [x] D7. Implement structured Core readiness/failure verdicts and consistent Shell, Marketplace,
      SDK, CLI and MCP handling without hidden failures or actionable unresolved candidates.
- [x] D8. Implement reviewed full source-binding migration, batch preview, idempotent operation
      recovery, explicit legacy-main-to-daily mapping, source-revision guards, custom-source
      exclusions, no downgrade on migration/channel switches and plan invalidation.
- [ ] D9. Complete the verification matrix, update affected feature/publisher documents and index,
      and delete this plan when its deliverables are complete; retain the separate Draft hardening.
- [x] D10. Separate exact-source check, artifact-build and release selections; implement the
      dependency/input graph, precise reasons, shared-input handling and necessary Docker context
      isolation, with conservative explicit fallback where safe narrowing cannot be proved.
- [x] D11. Implement canonical build-input fingerprints, verified digest reuse and per-artifact
      provenance, including mixed new/reused releases, native/source qualification and safe recovery.
- [x] D12. Implement automatic daily publication after successful main CI and manual stable promotion
      of an exact completed app release without rebuilding; include two-feed bootstrap/defaults,
      stabilization evidence, promotion records, feed isolation and idempotent concurrency guards.
      Keep the reusable publisher configurable for other feed names and promotion policies.
- [ ] D13. Publish immutable complete Core/CLI native bundles and platform feed metadata, including
      generic feed names/counts/defaults, this distribution's four targets, SHA256/provenance,
      native build selection/reuse, automatic daily
      and manual stable promotion without rebuilding, retention and conflict-safe pointer updates.
- [ ] D14. Implement shared persisted platform feed selection across Core/CLI/installers, settings
      and no-argument update, dynamic feed lists, canonical feed flags with channel aliases,
      paired bootstrap receipts,
      stable fresh defaults, the frozen cli-dev bridge, legacy-to-daily migration and custom-source
      preservation without fallback, app-source changes or implicit downgrade.
- [x] D15. Prepare/verify both native executables before disruption; add frozen resumable platform
      operations, launch/source guards, safe replacement/recovery, explicit partial outcomes and
      readiness verification while preserving stopped/dev Core modes, running apps and other roots.

## Verified implementation and remaining rollout

The registered implementation includes all nine app recipes and ten production profiles, independent
build/release selection, verified digest reuse, immutable app/platform publication, Core readiness and
preparation, reviewed binding migration, shared platform feed selection and resumable paired updates.

Verified on macOS ARM64 through 2026-11-04:

- All nine Docker images build for linux/arm64; generated manifests for all ten production profiles
  pass the real Core manifest consumer. The final Shell image includes UI recovery/error fixes.
- `node --test scripts/releases/*.test.mjs scripts/ci-policy.test.mjs .github/actions/ci-validation-gate/*.test.mjs`
  passes 198 publisher/registry/selection/metadata/workflow tests. Workflow lint is checked separately.
- The full Core test run has 4,591 passes, 13 failures and five explicitly skipped runtime scenarios.
  All 13 failures were corrected (catalog expectations and unchanged-artifact fixture identities);
  the final affected run passes all 60 tests. Other new readiness, migration and authorization tests
  passed their targeted runs. The five opt-in Harness/Telemetry/Docker-development/VPN scenarios
  were not run by the unit suite; this is not evidence of their runtime acceptance.
- CLI's full suite passes 381 tests; subsequent listener/recovery changes pass the affected 42 tests.
  Shell's full component suite passes 826 tests; ten final source/feed recovery tests pass after
  the last UI changes. The affected SDK and Marketplace suites pass 34 and 21 tests respectively.
- Native AOT Core/CLI pairs build for macOS ARM64 and Linux ARM64. The Linux executables report
  CLI version 0.172.0 and Core's initialization contract. This is build/smoke evidence, not a Linux
  paired-update lifecycle trial. macOS paired-update acceptance verifies corrupt-counterpart
  preservation, frozen recovery after discovery disappears, exact executable hashes, a new ready
  Core identity and retained custom listener. Its owned native child was finished and removed.
- Unix bootstrap parser tests pass. The PowerShell installer parser/receipt fixtures pass in the
  official PowerShell container and run under Windows PowerShell in the native CI job. Actual
  Windows executable replacement/readiness and Linux x64 runtime acceptance remain unverified here.
- The source sandbox demonstrates unavailable images suppress actionable offers without stopping
  a running app, successful Shell update from 1.0.0 to 1.1.0 while preserving stopped state, reviewed
  switch to a feed offering 1.0.0 without downgrading 1.1.0, and dynamic platform feeds with the saved
  Research choice preserved over a different default. Core's browser confirmation renders the exact
  old/new source and installed-ahead warning. Shell's missing source permission is correctly denied.
  After the owner granted `apps.sources.full` only to the disposable test Shell, the complete
  Shell-to-Core confirmation flow switches reviewed to frequent and returns to reviewed. The
  installed 1.1.0 remains stopped even though reviewed offers 1.0.0. Cancelling another confirmation
  preserves the reviewed binding and returns the editable draft without reporting success.
- Version consistency, documentation/index/link validation against `ci-publication/main` and
  `git diff --check` pass. The original checkout and ordinary installed applications remain unchanged.

D6 remains open for first public seeding/catalog coordination and external repository adoption;
the verified source inventory is in the publisher feature. D13/D14 retain public platform seeding
and frozen bridge rollout. D8's complete Shell-mediated source-switch acceptance passes. D9 retains
the native OS/runtime matrix and public mixed-artifact publication verification. Both managed test
sandboxes are finished: their processes, owned containers and temporary data roots are removed;
external browser/CLI consumers and the fixture server have stopped. The authorized source workspace
is retained for the pull request and CI fixes.
No public release, metadata branch, version alias or bridge was published by this session.
Local fixtures and mocked publisher tests do not count as public rollout.

## Delivery Sequence

Implement D3/D10 and D13 app/platform contracts and selection fixtures, D11 evidence/reuse,
D12/D13 publishers, then D7/D1 app protection and D14/D15 platform readers/preparation. Verify the
reader-capable bundle before the one-time cli-dev bridge, freeze the bridge, seed platform feeds
with manual initial stable approval and enable the new defaults/migration. Then seed each app's
daily and manually approved stable releases, offer D8 legacy-main-to-daily migration and perform
D6 default cutover only on a Core with app.0.2 support. Finish D9 acceptance across both release
families. Channel/feed naming is not a product-wide version lock or automatic app upgrade policy.
Keep one feature branch/PR per affected repository. Implementation starts by changing this plan to
In Progress; check each ID only after its verification passes. No open design questions remain in
this approved scope. Documentation-only changes need no version bump; shipped code follows each
affected artifact's independent version rules.

## Verification

- Run `node scripts/docs-index.mjs --check --base <ref>` and repository diff checks for plan edits.
- Selection fixtures: Core-only changes with no app build dependency or pending app publication
  produce Core checks/builds and zero app-image builds/releases; recovery names its previously pending
  app release rather than claiming the Core-only diff changed that app;
  one app selects its own artifacts; docs/tests/branding-only changes can broaden checks without
  unrelated image builds; shared SDK/dependency/base/toolchain changes select every real consumer;
  unknown build inputs retain a visible conservative fallback. Check root-lock metadata-only and
  transitive/peer/hoisting changes, actual pruned builder inputs, deletes/renames and manual-all checks.
- Reuse fixtures: identical inputs reuse the exact digest without invoking the builder; changed or
  unprovable inputs, missing images/provenance or incompatible fingerprint formats cannot reuse.
  Verify platform sets, immutable aliases, unchanged-version rebuilds, no relabelled source commits,
  and Telemetry UI-only release with the old verified backend plus combination validation.
- Publication fixtures: every repository runtime app, delayed/missing service image, native/source
  profile, third-party dependency, unsupported architecture, concurrent apps, out-of-order runs,
  failed upload, missed publication, stale cached feeds and interruption between immutable upload
  and pointer promotion. Readers always see a complete release; unrelated main commits do not strand it.
- Generic feed fixtures for app and platform indexes: one unrelated ID as implicit default, two
  custom IDs, three feeds with a named default and ten custom feeds without daily/stable/main.
  Verify dynamic UI/CLI listing, saved/no-argument resolution, explicit selection when several feeds
  have no default, duplicate/empty/overlong IDs, multiple defaults, removed selected feed and changed
  publisher default. Exercise a publisher configuration with different automatic/manual rules;
  familiar names confer no bypass and the stock two-feed bootstrap/migrations do not leak into it.
- Channel fixtures: PR creation/update cannot advance feeds; successful eligible main publication
  advances only daily, including several releases in a day; no-op commits leave pointers unchanged.
  Stable changes only on exact manual promotion, never because tests passed or a stabilization
  timer elapsed.
  Promotion performs zero image builds and preserves manifest/version/digests/provenance. Exercise
  an older retained daily candidate while a newer daily release exists, wrong app/release, missing
  artifacts/evidence, repeated dispatch, stale expected pointer, same-version distinct releases,
  concurrent daily/stable updates and stable regression refusal. Verify promotion records and
  unchanged pointers after failure. Bootstrap exposes no dangling or implicitly default daily feed;
  initial stable requires an explicit selection, new installs default to stable with no daily/main
  fallback, and an explicit daily install resolves daily.
- Core fixtures: old/new schema, malformed manifest, wrong app identity, missing/mismatched digest,
  platform/access failures, timeout/rate-limit/ambiguous responses, bounded retry, last-success
  history and no actionable unresolved offer. Exercise an empty registry and unrelated third-party
  ID through non-GitHub feeds without Marketplace/Harness or copied publisher credentials.
- Migration fixtures: old feeds/direct URLs, old Core behavior, custom/private/fork/pinned/live
  sources, user changes during review, installed-ahead and unknown ordering, inaccessible destination,
  interrupted/repeated/batch operations and source return. Verify explicit old-main-to-daily mapping,
  no implicit migration to stable, stable selection while daily is ahead, and changing channels when
  both point at the same release. Assert preserved installed state/data, no lifecycle action or
  automatic downgrade, no daily/moving-main fallback for stable, and refusal of old-source update
  reviews after switching.
- Platform publication fixtures: all eight artifacts on the four supported targets, a missing RID
  or role, duplicate asset, bad hash/version, cancelled matrix leg, interrupted upload, write-once
  retry mismatch, same-version rebuild, unrelated app change and pending native publication recovery.
  Verify embedded-version/revision inputs prevent unsafe reuse; stable promotion builds nothing and
  retains the exact descriptor/binaries. Concurrent app/daily/stable publishers preserve each other.
- Platform feed fixtures: no-argument update honors saved stable/daily and agrees with Core status
  and its apply action; explicit feed flags, legacy aliases, conflicting flags, explicit local/remote
  index, explicit legacy unversioned index, corrupted/missing selected feed, changed publisher
  default, unknown ordering and downgrade
  refusal. Verify settings/CLI selection has no lifecycle side effect and updates invalidate stale
  offers. A platform feed change never changes app feeds; exercise Core with no runtime apps.
- Bootstrap/migration fixtures: fresh Unix/PowerShell stable/daily install, feed moving between CLI
  install and first Core start, legacy no-config and exact main/cli-dev records, custom repo/tag/index,
  incompatible metadata, bridge publication/cutoff, retained old clients and interrupted/repeated
  source migration. Initial Core matches the CLI receipt, selected feeds survive subsequent commands,
  a missing stable never falls back, and the bridge stops changing after its recorded cutoff.
- Platform operation fixtures: missing/corrupt second asset before stop, denied filesystem access,
  feed movement after check, source/instance changes before apply, failed stop, replacement failure,
  crash after either executable swap, uncertain replay, recovery failure and failed readiness. Verify
  exact frozen-target recovery, honest exit/status results, no preflight disruption, safe pre-launch
  restoration, no automatic post-launch data rollback, active/stopped/dev distinctions, shared CLI
  locks and independent data roots. Preserve running Docker apps and supported local runners.
- Run affected Core/CLI builds/tests, Shell/Marketplace/SDK checks, selection/reuse/publisher tests,
  workflow lint, version consistency, changed app builds and all four native publish checks. Run
  Unix/PowerShell installer contract tests and real native update/swap checks on supported platforms;
  name unavailable OS coverage explicitly rather than treating mocks as native acceptance.
- In a Core-managed sandbox with separate users/data and normal login, install an old release,
  observe delayed publication without an offer, complete a mixed new/reused release, migrate and
  review/apply its exact artifacts through Core/Shell. Manually promote that exact daily release to
  stable, verify no build or daily-pointer change, and verify new-install default/channel switching.
  Deny access after planning and verify preparation leaves the working app running. Repeat
  source/native acceptance through its supported test path. In a managed child Core with its own
  installed CLI/Core paths and separate data, verify legacy-to-daily migration, stable selection,
  no-argument update, the frozen two-binary preparation/restart and actual process readiness. Use
  controlled release fixtures and never replace the operator's CLI/Core or publish a real stable
  release merely to run acceptance. Exercise native Windows replacement on Windows and keep the
  supported local-source path for dev-mode preservation checks. Export useful results, Finish the
  owned sandbox and verify removal. Plan-only edits need no runtime sandbox, compilation or app tests.
