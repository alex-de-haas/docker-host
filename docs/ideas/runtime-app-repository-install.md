# Runtime App Repository Install

Status: Idea
Created: 2026-06-12
Updated: 2026-06-12

## Motivation

Hosty now supports installing a local runtime app from a directory containing `manifest.json`, which covers the manual clone flow:

```bash
git clone <runtime-app-repository>
cd <runtime-app-repository>
hosty apps install .
```

A direct repository install flow could remove the manual clone step by letting users pass a Git repository URL whose root contains `manifest.json`.

## Possible Approaches

### Core-Managed Repository Install

Core accepts a repository URL, clones it into managed source storage, reads `manifest.json` from the repository root, and installs the app from that checked-out source.

Pros:

- Keeps install source state in Core-owned lifecycle and cleanup paths.
- Reuses existing managed checkout concepts for source resolution.
- Gives Shell and CLI the same behavior through the Core API.

Cons:

- Requires repository URL parsing, ref selection, cleanup, and credential policy in the install path.
- Makes install slower and dependent on Git availability/network behavior.
- Needs careful treatment of private repositories and embedded credentials.

### CLI-Prepared Local Directory

The CLI clones the repository into a local directory first, then calls the existing Core install API with that directory path.

Pros:

- Keeps Core install behavior simple.
- Makes the clone location explicit to the operator.

Cons:

- Shell cannot use the same flow.
- Source state may be split between CLI-created files and Core-managed app records.
- Cleanup and retry behavior become less predictable.

## Risks

- Repository URLs with embedded credentials could leak through logs, app state, or Shell-visible output.
- Private repositories need a credential provider and storage policy before they can be supported safely.
- Branch/tag/commit selection affects reproducibility and update behavior.
- Large repositories, submodules, sparse checkouts, and Git LFS could make installs slow or incomplete.
- Multiple manifests in one repository would need an explicit path contract; implicit recursive scanning should be avoided.

## Open Questions

- What exact input should identify a repository install?
  Answer: Not decided. It could be a separate option such as `--repository`, a URI scheme, or automatic Git URL detection.
  Recommendation: Prefer an explicit `--repository` option so manifest URLs and repository URLs are never ambiguous.

- How should users select a branch, tag, or commit at install time?
  Answer: Not decided. Existing source resolution supports branch, tag, and commit later, but install would need an initial immutable source state.
  Recommendation: Require an explicit ref option for non-default installs and record the resolved commit in app source state.

- How should private repositories authenticate?
  Answer: Not decided. Current managed source workflows reject embedded credentials and SSH-style repository URLs.
  Recommendation: Keep private repository installs out of scope until Core has a credential provider.

- Should repository install scan subdirectories for `manifest.json`?
  Answer: Not decided. Recursive scanning is convenient but can produce ambiguous installs.
  Recommendation: Start with repository-root `manifest.json` only, then add an explicit `--manifest-path` option if subdirectory apps become necessary.

## Current Recommendation

Do not implement repository URL install yet. Keep the current supported flows as manifest URL, local manifest file, and local app directory. Use direct repository install as a future feature after credential handling, ref selection, source state, and cleanup behavior are specified.

## Links

- [Runtime app manifest](../features/runtime-app-manifest.md)
- [Runtime source workflows](../features/runtime-source-workflows/feature.md)
- [Runtime source extensions](runtime-source-extensions.md)

## Notes

The local directory install flow is the recommended bridge for downloaded or manually cloned runtime app repositories.
