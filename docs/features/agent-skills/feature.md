---
created: 2026-10-26
updated: 2026-10-30
summary: A shared library of Core, Git and app skill packages with stable selections, current-file exports and platform context for native agents.
components: [apps/core, apps/cli, apps/harness]
---

# Shared Agent Skills

Core exposes one library for the instance. Its executable ships two built-in packages; Git sources
and installed apps supply administrator-managed packages. All are complete Agent Skills directories: `SKILL.md` with YAML `name` and `description`, plus
references, scripts, examples and assets. Hosty metadata stays outside portable package files.
Native package guidance is selected independently of tool access and permission to run scripts.
[Core platform skills](../core-platform-skills/feature.md) additionally supply a bounded platform
introduction to consumers that request it; Harness requests it for every agent.

## Catalog And Administration

Harness Settings → Skills displays names, descriptions, source provenance, installed commits/app
versions, `Core · <version>` provenance and package files. Core packages have a Read action and
update only with Core; their catalog presence does not depend on installed applications. Administrators can filter and read packages, discover a Git repository
or subdirectory, select packages, install them, check updates, update individually or together,
and remove Git packages. **Add skills** opens a two-step dialog: repository and source connection,
then discovered package selection. A text field above the results filters names and descriptions
as the administrator types, without changing selected packages hidden by the filter. The results
use rows separated by thin dividers and scroll independently while the filter, **Back**, **Cancel**
and **Install selected** stay visible. Back restores the source form; rediscovering the same source and
commit preserves selected packages. Cancel closes the whole dialog and preserves its draft.
Successful installation closes it and refreshes the catalog. Private Git uses the acting administrator's existing Source connection.
Connection ownership and revocation are checked by Core; secrets are absent from catalog results.
There is no manual archive upload, package editor, personal library or automatic update.

Each operation fetches a shallow repository checkout and shares it across selected packages from
that source. Only selected complete packages enter the library. Discovery records a commit;
installation rejects a moved source rather than substituting different content. Checking updates
does not install anything. Applying an update that removes a selected upstream package removes
that package. Failed source reads preserve installed contents. App packages follow their applied
app version and disappear when their supplying app is removed.

Stable Git identities include repository, ref and package path; app identities include app ID and
manifest key. Core identities use the source kind and package name. New packages cannot use
reserved Core native names. Existing same-name packages survive upgrades, but an export selecting
both the legacy and Core package fails before replacing existing files. Other technical collisions
are rejected without renaming or overwriting unrelated packages. Hosty does not analyze contradictory
instructions. Imports validate YAML, paths, case collisions, regular files and package limits;
symlinks, traversal and Git metadata are refused. Limits are 512 files/16 MiB per package,
256 KiB for `SKILL.md`, and 200 packages/64 MiB for the managed library. Core packages are outside
that capacity; exports and Harness selections accept all 200 managed packages plus both built-ins.

## Local Git Installation

The local operator can install selected public Git packages directly into the shared library:

```sh
hosty skills add https://github.com/github/awesome-copilot --skill csharp-xunit
hosty --data-root /path/to/instance skills add https://example.org/team/skills.git \
  --skill testing --skill review --ref main --path skills --format json
```

`add` requires at least one exact SKILL.md frontmatter name. Repeated `--skill` arguments select
multiple packages; identical selectors are deduplicated. `--ref` defaults to `HEAD`, and `--path`
defaults to the repository root. Repository URLs use the existing credential-free HTTP(S) Git
contract. GitHub shorthand, browser `/tree/` URLs, private Source connection flags and an implicit
install-all mode are not supported. The selected Core instance must already be running.

The command discovers metadata and installs at the observed commit. A moved ref, missing name,
ambiguous name or invalid selected package fails before publication. Ambiguity diagnostics show
candidate paths for narrowing `--path`. Selection reads names from metadata rather than assuming
directory names; full package validation still enforces the portable directory-name contract.
Discovery reads only SKILL.md frontmatter, bounded to 256 KiB per header, 10,000 directories,
20 levels and 64 MiB of metadata. Invalid or
unreadable metadata and exceeded scan bounds produce errors instead of incomplete selections.
Large upstream catalogs can contain more than 200 packages: full file validation applies only to
selected packages. Oversized unselected instruction bodies and ancillary files do not block
selection or consume installed library capacity.

Success prints a readable summary and table of the packages installed by this command.
`--format json` returns only those packages with full metadata, stable IDs and commits.
Re-adding the same repository/ref/path replaces its current contents with the same stable ID;
existing exports refresh through the ordinary library publication path. Unrelated packages and
profile selections stay intact. Installation never runs package scripts or provisions native homes.

The local `/control/v1/skills/discover` contract accepts `{ source, names }` and returns selected
metadata with the observed commit. `/control/v1/skills/install` accepts `{ source, commit, names }`
and returns the installed package catalog. Both require the existing local control secret and
reject non-null Source connection IDs. Private imports retain the administrator HTTP contract
and owned Source grants. Successful local publication records `skills.library.modified` with
`via: local-control` and no fabricated user identity.

## API And Delivery

| Consumer | Contract |
| --- | --- |
| Signed-in user/operator app | `/api/skills`: catalog, file reads, discover, install, check-updates, update and delete |
| Installed app | `/api/internal/apps/{appId}/skills`: catalog, file reads and owned exports |
| Local operator | `hosty skills add`, `list`, `read`, `export` and `release`, through local Core control |

Browser/API library writes require a current administrator; app-mediated management additionally requires
`skills.manage`. App catalog/read/export calls require its service identity and `apps.skills.read`.
Private repository reads use saved Source grants. Management mutations record actor provenance in
the audit log. An app cannot release another app's exports.

`POST .../exports` accepts `{ contextId, skillIds, includePlatform? }`; repeating a context updates
that consumer's export. The result contains its ID, native path and available selected metadata.
`includePlatform: true` adds `hosty-platform` and returns `platformIntroduction` with its stable
`skillId`, `coreVersion`, reference `path` and bounded `text`. The default preserves explicit selection
for external consumers. Core catalog entries have `sourceKind: core`, `coreVersion` and an optional
`introductionPath`; no app identity is required to describe them. Missing IDs are
omitted. `DELETE .../exports/{id}` releases an unused export. Content reads accept a package-relative
`path`, return bytes as Base64, and list package file paths.

Core stages complete exports and the next state file before publication. Preparation failures leave
current contents available; after commit, publication finishes despite caller cancellation. Core
keeps one current package state and updates selected export directories after publication.
The export parent remains stable for existing bind mounts. Each package uses a complete-directory
replacement; native readers can briefly observe a missing path between renames. Package replacement removes stale
files; startup recovery reconstructs registered exports and clears temporary staging/fetch data.
Temporary checkout cleanup clears Windows read-only attributes without following links. If a
fetch directory remains locked or inaccessible during startup, Core logs a warning and retains
it for the next recovery; the installed library and reconstructed exports remain available.
There are no historical package revisions or conversation pins. A native client may retain text
already loaded in its conversation; updating/removing files cannot retract that text.

The `agent-skills` external-mount kind exposes only the requesting app's export collection,
read-only, to declared services. It requires instance scope, `mode: ro` and `apps.skills.read`.
Core supplies `HOSTY_MOUNT_<KEY>` using the ordinary mount environment contract. Selection controls
Hosty delivery, not filesystem permissions or unrelated user/repository/built-in skills.

## Harness And External Clients

Harness [agent profiles](../agent-profiles/feature.md) store explicit skill selections. The Skills
tab manages the common catalog; profiles own optional selection. Harness always requests platform
context, exports its package and places the introduction before its mode-specific environment and
operator/role instructions. The profile editor shows this package checked and unavailable for
deselection; `hosty-app-skill` remains optional. Existing saved optional selections are unchanged. Session creation also accepts explicit
`skillIds` for manual consumers without a profile. A session captures
its selection while receiving current contents whenever Core updates those packages. Provider
credential connections do not own skill selections. Deleted IDs do not block session creation.

The worker resolves an export ID inside its app-scoped collection. Codex discovers the selected
directory through a per-run `HOME/.agents/skills` link, retaining the connection's `CODEX_HOME`.
Claude receives a per-run `CLAUDE_CONFIG_DIR/skills` link and shared connection history. Docker
workers use their existing isolated native profiles and the read-only collection mount. Two runs
using one provider connection can have different Hosty selections without rewriting shared
native skill configuration. Native profile cleanup follows process shutdown; session deletion
releases its Core export.

An independent local Codex consumer can run:

```sh
hosty skills list
hosty skills list --format json
hosty skills export --context my-agent --skill <stable-id> --link <dedicated-home>/.agents/skills
HOME=<dedicated-home> CODEX_HOME=<connection-home> codex
hosty skills release <export-id>
```

`hosty skills list` defaults to a table of skill names, source kinds and descriptions abbreviated
to 120 characters. `--format table` explicitly selects that view. `--format json` returns the full
catalog, including stable IDs for read/export commands and complete descriptions. Scripts consuming
the previous JSON-only default must add `--format json`. Empty tables display `No skills installed.`
Invalid list arguments fail before connecting to Core.

The CLI never replaces an existing ordinary directory or unrelated link. Remote MCP alone does
not provision filesystem packages. The CLI MCP connector and HTTP facade supply tool descriptions
and their own instructions; neither injects skill bodies into MCP initialization.

## Migration And Release

The [app package contract](../app-provided-skills/feature.md) replaces `agent.skillFile` with
`agent.skills`. New installs/updates reject the retired field with a migration diagnostic;
already installed legacy manifests remain manageable without delivering their old file.
Previously selected Harness app guidance maps once to the supplying app's stable `default` key,
including when that app upgrades later. New packages stay unselected. Digest approvals no longer
control skill delivery.

Release Core/CLI before Harness and migrated skill-supplying apps. This repository supplies
Documents and Demo App packages; the installed Media Server producer has a coordinated migration
in its own repository. SDKs have no manifest skill-file schema to migrate: app consumers use the
neutral HTTP contract. Native MCP plugin skills are separately installed packages and stay intact.

## Verified Consumer Behavior

The 2026-10-26 macOS acceptance run uses Codex 0.162.1 and Claude Agent SDK 0.3.296,
with a local synthetic inference endpoint and no live provider credentials. Both real Harness
adapters discover two different concurrent selections on one connection, activate the selected
package, read nested references and resume saved conversations against manually updated files.
An independent local Codex CLI consumes a separately provisioned `hosty skills export` link.
These checks verify delivery and native tool execution, not model judgment or workflow obedience.

A parent-managed source child Core supplies normal password login, Shell embedding and the
Harness library UI. A separate unrelated Docker app creates its own export through the service
API and reads it from Core's read-only collection mount; manual updates change files inside
an already running container. Explicit upstream removal clears selected exports. Both native
adapters accept fresh and resumed turns with a removed skill ID; fresh catalogs omit it. App lifecycle acceptance covers multiple
packages, stable keys across directory moves, updates, invalid-package rejection and removal.
Private Source revocation is covered with real Git and a substituted authenticated transport;
ordinary operator credentials are not used by the acceptance fixtures.

Native history can retain previously loaded instructions. Resume reads current files but cannot
erase earlier messages, and Hosty does not require immediate catalog refresh in a running turn.
Missing selections produce an empty or reduced current export rather than preventing a session.

The 2026-10-30 macOS arm64 CLI acceptance run uses a parent-managed child Core with separate
data and normal test-user setup/login. `npm run test:integration -- skills` passes actual HTTP Git
imports from a 240-package fixture, repeated selectors, ref/path selection, atomic failures,
oversized unselected instructions, moved-source rejection, stable reinstallation IDs and
add/list/read/export/release. The exact public example above installs `csharp-xunit` from
awesome-copilot commit `5269f7ea2d6c3a9bfda5ed878b6726cf509121fd`. Parent Finish confirms child
resource removal; the fixture checks process exit and port release before removing its data.

Verification for this change includes Core/CLI builds, 356 CLI tests and 15 integration-runner
tests. The full Core run passes 4386 tests with five unrelated opt-in integration skips; after
the final metadata-reader adjustment, all 50 affected skill/audit tests pass again. NativeAOT
publish and startup smoke pass on osx-arm64 without new trim/AOT warnings. The full Core suite
is not repeated after that isolated adjustment; Windows and Linux runtime checks are not run.

## Testing Expectations

- Cover the CLI's default and explicit table output, literal package text, abbreviated descriptions,
  complete JSON output, empty catalogs and argument errors without a running Core.
- Cover selected public imports, repeated selectors, ref/path propagation, large upstream catalogs,
  ambiguity, metadata and selected-package failures, moved commits, stable reinstallation IDs,
  export refresh, local authentication/audit and rejection of private connection IDs.
- Run `npm run test:integration -- skills` for real Git transport and CLI add/list/read/export/release
  in a parent-managed child Core, normal test-user login, the public awesome-copilot example and
  Finish cleanup. Keep live upstream failures distinct from deterministic fixture results.
- Cover built-ins without installed apps, Core version provenance, protected lifecycle, reserved
  names, legacy collisions, recovery from packaged bytes and platform-context opt-in.
- Cover complete packages, path/YAML/size validation, source selection and moved commits, manual
  updates, upstream removal, failed private reads, name collisions and app lifecycle publication.
- Cover read-only Git pack cleanup on Windows, retained locked fetch directories during startup,
  cleanup retry, and preservation of library contents and link targets.
- Verify administrator/app-grant boundaries, revoked access, independent consumers, export
  ownership, current contents, missing IDs and recovery without historical packages.
- Exercise Harness profile and explicit session selections independently of MCP access and instructions;
  verify concurrent native profiles, references, update/removal and retained conversation history.
- Build Core/CLI, Harness UI and migrated producers; run affected unit/integration suites and
  real native discovery/activation checks against the pinned Codex and Claude versions.
- Use a parent-managed child Core, normal test-account login and Core-managed app launch for
  runtime/browser acceptance; export results and Finish its resources through the owner.
