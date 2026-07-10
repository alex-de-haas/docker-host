# Update Channels

Status: Idea
Created: 2026-06-12
Updated: 2026-07-10

## Description

Update channels add a discovery layer above concrete runtime app manifests, source refs, image tags, and release artifacts. Selecting a channel should resolve to a concrete manifest or source snapshot, then reuse runtime app update planning.

## Scope

- Product channel index for Hosty Core executable artifacts, Shell, and optional CLI delivery.
- Runtime app channel indexes that resolve to `app.0.1` manifest snapshots or source refs.
- Pull request channels for validating temporary builds.
- Channel cleanup for expired pull request builds.

## Channel Types

- `stable` - deferred until there is a promotion process separate from `main`.
- `main` - default development channel.
- `pr-<number>-<branch-slug>` - temporary pull request channel.

## Runtime App Channel Resolution

Runtime app channels should resolve to:

- `appId`
- `manifestUrl` or manifest snapshot path
- source repository/ref/commit when source-backed
- image repository/tag/digest when Docker-backed

## Product Channel Placeholder

The committed `channels/product-channels.json` file is a local placeholder, not a generated release index. Its Core entry identifies the `hosty-core` artifact family. It must not point at the repository Core `.csproj`, because default Core start uses the installed executable and source mode is only selected with `hosty core start --project <csproj-path>`.

## Decisions And Recommendations

- Generated channel indexes should not be committed to the repository.
  Recommendation: generate indexes in CI and publish them alongside release artifacts.

- Runtime profile switching and channel switching should happen together only when a reviewed plan explicitly combines them.
  Recommendation: keep them separate by default.

## Links

- [On-Demand System App Updates](system-app-updates.md) — uses configured manifest sources for the first manual Shell update flow and leaves generated product channels as the later atomic release source.
