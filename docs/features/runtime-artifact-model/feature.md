# Runtime Artifact Model

Created: 2026-07-02
Updated: 2026-09-17

## Execution And Artifacts

A runtime profile declares a command recipe and an execution type. Docker profiles execute images or explicitly mounted development source;
`localCommand` profiles execute source commands or a prebuilt artifact. Profile keys are arbitrary:
`dev` is a naming convention, not a reserved runtime type.

| Execution | Artifact | Behavior |
| --- | --- | --- |
| `docker` | `image` | Reviewed image digest lock |
| `docker` | `source`, `development: true` | Source mount inside a locked development environment |
| `mixed` profile | Per-service `image` or `source` | Dependency graph across Docker and local commands |
| `localCommand` | `source`, `development: false` | Reviewed contract; managed Git source is pinned to the reviewed commit |
| `localCommand` | `source`, `development: true` | Editable source, live manifest adoption on restart |
| `localCommand` | `prebuilt` | Content-hashed immutable folder copy |

Development profiles use `development: true`. More than one profile may declare it; profiles share
the app's source state. Docker development and mixed profiles support explicit source services alongside image dependencies;
see [Mixed Development Runtimes](../mixed-development-runtimes/feature.md). Development profiles containing prebuilt services are rejected by manifest validation. Prebuilt artifacts stay immutable and require a reviewed profile.
The profile supplies `setup` and service `command` values. Core does not infer hot reload from the
name, install watchers on behalf of the app, or equate the working tree with code loaded by a process.
A source `setup` command runs before service startup; the application chooses how to cache its build.

## Profile-Bound Development

Choosing a development profile selects live source behavior. Choosing a reviewed profile selects
its image, prebuilt artifact or reviewed source contract. There is no independent mode switch. Shell displays the target profile's Live/Locked badge in the runtime selector
and shows the Live icon beside the selected runtime exactly when its `development` flag is true,
including single-profile apps. Source settings list declared development profiles.

`source-override` remains installation state, not public manifest metadata. Development uses the
operator override, an installed local folder or a materialized managed checkout. The Source tab
is available for source-capable apps, including apps that have only a reviewed source profile.
A local folder without a pinnable repository has no immutable Git-baseline guarantee.

Live apps adopt manifest edits on restart and do not use the ordinary reviewed update flow.
An explicit external manifest comparison remains available through the existing update API.
For source paths, command supervision, runtime switching and failure semantics, see
[Runtime Source Workflows](../runtime-source-workflows/feature.md).

## Stored State And API

The manifest flag is the only development setting. Core ignores obsolete `developmentModes` and
`developmentModeBaselines` fields in stored records; normal writes omit them. There is no migration
review, response alias or `/development-mode` endpoint. Installed manifests must declare the intended
profiles before adopting this contract. Historical data backups remain ordinary backup records.

## Prebuilt Folder Delivery

A `localCommand` profile can declare `artifact: prebuilt` with a folder delivery. Core hashes the
folder, materializes it under `apps/<id>/runtimes/<key>/artifact/<hash>/`, records `BundleHash` in
its artifact lock, and runs from that immutable copy. Repeated starts retain the locked copy; a
reviewed update drops the lock and permits adoption of the current delivery. Source checkouts
remain app-level under `apps/<id>/source`, with persisted legacy paths honored.

## Testing Expectations

- Arbitrary names and multiple declared development profiles work; `dev` without the flag is reviewed.
- Docker source and mixed development profiles validate all declared recipes, including unselected
  profiles; development prebuilt artifacts are rejected and reviewed prebuilt artifacts stay immutable.
- Obsolete mode fields cannot override the manifest on reads, starts or restarts and are omitted on write.
- Failed runtime switches retain the previous selection and recoverable source state.
- A pinned start preserves staged, unstaged, untracked and ignored source files; dirty work refuses startup.
- Prebuilt hashing, immutable copies, lock reuse and reviewed-update invalidation remain covered.
