# App Publication

Status: Draft
Created: 2026-09-16
Updated: 2026-09-25

## Code PR Publication Boundary (2026-09-24)

[Shared assistant development sessions](../assistant-development-sessions/plan.md) owns Publish/review/
Merge/Complete for code changes, including dependency-ordered merges, post-merge checks and corrective
PRs. This plan continues to own repository provisioning, installable releases/feeds and catalog
promotion. Reuse their recorded commits, PRs and artifact observations where the workflows meet;
do not make the session's Publish button imply a release, catalog listing or installation update.
The two plans retain separate deliverables and approval boundaries.

## Goal

Promote a local [authored app](../app-authoring/plan.md) into a reproducible installable release and,
optionally, a Marketplace listing. Local use remains valid indefinitely; publishing is not required
to save a prototype or to keep editing it.

## Target Behavior

Use existing repository-owned manifests/feeds and Core's reviewed install/update model. Publishing
has separate milestones, each independently observable and retryable:

1. **Saved source:** consume the optional Git initialization/commit/push workflow owned by
   [prototype workspaces](../app-prototype-workspaces/plan.md). It is already available during
   iteration; this feature does not implement another source-history or export service.
2. **Hosted repository provisioning:** choose provider, account, repository name and visibility;
   create a hosted repository if needed, then use the existing Git workflow to connect/push.
   A configured remote is not proof of a pushed commit.
3. **Release:** validate a self-contained source runtime or build a distributable image/artifact,
   publish versioned manifest and `app-feeds.0.1` feed using existing contracts. Docker is optional;
   source releases must declare their setup/toolchain requirements and be usable outside this host.
4. **Catalog submission:** read the chosen catalog's actual contribution rules/schema, prepare the
   entry and assets pointing to the app-owned feed, and open a reviewable PR when authorized.
5. **Catalog availability:** report the PR as submitted until the catalog maintainer merges and the
   resulting catalog actually lists it. Submission never implies approval or installation elsewhere.

Preserve app id, data and source across promotion. Switching the current installation to follow the
new feed is a distinct reviewed operation, not a side effect of pushing source. A Git push by itself
does not produce automatic Hosty updates. Public ingress/Cloudflare publication is unrelated.

## Boundaries And Extension Points

Read-only catalog search and app-detail MCP tools are tracked in
[Marketplace discovery](../runtime-app-marketplace/plan.md). Authoring uses them to recommend
existing apps before creating duplicate wrappers; catalog-submission actions remain owned here
and do not inherit permission from a discovery call.


- Repository provider operations belong to the authoring workflow or a provider app/adapter, not
  Core's generic app lifecycle. Choose a first provider rather than building every provider at once.
- Marketplace owns catalog-specific instructions and submission metadata. Start with a maintained
  instruction contract; add MCP only for concrete structured queries/actions that need it. Current
  skill delivery follows enabled MCP providers, so a skill-only Marketplace is not automatically
  discoverable: decide an explicit delivery path instead of assuming `agent.skillFile` alone works.
- A Marketplace tool may prepare/submit a catalog contribution with its own scoped authorization;
  it must not inherit authority to install, update or remove apps. Core remains catalog-agnostic.
- Keep repository tokens in the selected credential provider, never prompts, generated app files,
  manifests, feeds or browser-visible state. Honor private-repository limitations of Core's source
  resolver; private source publication is not proof that another host can install it.
- Review the concrete file diff, repository/visibility, artifact destinations and catalog PR before
  the corresponding external action. Reuse existing session approvals; do not interpret a request
  to create a prototype as authorization to make its source public.

## Deliverables

- [ ] Choose first repository provider and catalog; specify authentication and instruction delivery.
- [ ] Implement provider-specific hosted repository provisioning when requested and compose it with
      the existing assisted Git save/push flow, preserving source paths and idempotent retry behavior.
      Generic Git initialization/commit/push is owned by the prototype feature, not duplicated here.
- [ ] Produce a reviewed release bundle: source/version, manifest, artifact/setup, feed, description
      and optional screenshots/icon; exclude secrets, local absolute paths, caches and runtime data.
- [ ] Validate clean installation and a subsequent version update through Core from the published
      feed, with required version changes and artifact references kept consistent.
- [ ] Implement catalog-owned submission guidance and optional typed tools with explicit provider
      enablement/authority; create the catalog diff/PR and report its actual state without auto-merge.
- [ ] Record publication references and partial failures independently (commit, pushed revision,
      release/feed, PR, observed listing); retry without duplicate repositories, releases or PRs.
- [ ] Document the shipped workflow, remove this plan, regenerate the index and bump affected
      components. Reuse the workspace/session model instead of moving source during publication.

## Phases And Open Questions

One feature PR for the selected provider/catalog: contract and credentials → source/release
publication → catalog submission → clean-consumer verification. Before Ready, decide provider,
repository visibility default, supported release kind, catalog rules delivery, and exact review
boundaries. If a narrower independently useful feature is wanted, split ownership explicitly before
approval; do not silently omit catalog work during implementation.

## Verification

On an authorized test repository/catalog, publish a no-Git prototype, then install its feed on a
separate test host or CI environment and update to a second version. Do not start a second Core on
the live host. Verify private visibility is respected, no secret/data paths enter the release,
failed artifact publication leaves the local app usable, retry does not duplicate the PR, and a
pending/rejected catalog PR is never shown as a listing. Verify the original installation's feed
and app data remain unchanged unless a separate reviewed switch is requested.
