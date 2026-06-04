# Update Channels

## Description

Update channels add a discovery layer above concrete runtime app manifests, source refs, image tags, and release artifacts. Selecting a channel should resolve to a concrete manifest or source snapshot, then reuse runtime app update planning.

## Scope

- Product channel index for Hosty Core, Shell, and optional CLI delivery.
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

## Open Questions And Recommendations

- Question: Should generated channel indexes be committed?
  Answer: No. They are release artifacts.
  Recommendation: Generate indexes in CI and publish them alongside release artifacts.

- Question: Should runtime profile switching and channel switching happen together?
  Answer: Only when a reviewed plan explicitly combines them.
  Recommendation: Keep them separate by default.
