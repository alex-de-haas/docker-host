# Marketplace MCP Capability Discovery And App Reuse

Status: Draft
Created: 2026-09-25
Updated: 2026-09-26

## Goal

Expose Marketplace discovery through app-owned MCP so an authoring agent can select ready-made
building blocks from the capabilities a requested application needs. Owner clarification, 2026-09-25:
this is capability-led solution discovery throughout app design, not only duplicate-wrapper detection.
The user need not know provider names: a video-editor request may lead the agent to propose a
compatible Transcode Engine for the specific operations its published contract supports. Finding
an existing MongoDB wrapper is one case of this broader workflow. This Draft authorizes no implementation.

## Change Against Current Behavior

[Current Marketplace](feature.md) provides authenticated storefront search and catalog/feed details;
this proposal adds a structured agent interface to that discovery. Keep catalog ownership in
Marketplace and installed state/lifecycle in Core. Reuse the configured catalog source; this work
does not require multiple sources, federation or a new Core catalog API.

Provide read-only search and app-detail operations (tool names remain open). Search by name and
description/tags first, with capability/interface and upstream repository/image matching where
reliable metadata exists. Details carry stable app ID, catalog provenance, feed references and
available version/runtime/dependency/interface facts, including missing or unverified fields.
Resolve feed/manifest details where needed and mark their source and freshness. Do not pretend the
current catalog index already contains complete compatibility metadata. Core remains authoritative
for validating an actual install/update plan on the target host.

## Product Classification: Tools And System Apps

Introduce a discoverable “Tools” classification for reusable functional providers such as Torrent
Engine, Transcode Engine and a MongoDB wrapper. These are apps that primarily supply services to
other apps and commonly have no end-user UI. An optional administration UI does not remove their
provider purpose, and the absence of UI alone is not proof of a useful integration contract.

Keep this classification separate from `role: system`, which describes platform role/access for
components such as Shell and Marketplace. Do not rename that role or mark tool apps as system apps
merely to group them. “Tool” here means a reusable app/component, not necessarily an MCP tool:
its consumer interface may be an HTTP API, another protocol or MCP where declared.

Propose catalog/detail presentation and a Tools filter alongside search by functional capability.
Describe provided operations, interface/protocol and version, relevant constraints and integration
guidance with evidence from the provider contract. Reuse existing metadata where appropriate;
the exact category/tag/structured-field representation remains an open design decision. Existing
`provides` slots and `interfaces` may contribute evidence, but are not automatically a complete
feature taxonomy. Prefer declared versioned interface/operation contracts as machine-matching
evidence; free-text tags are candidate-discovery hints. Missing contract facts stay unknown.
Keep the owner's Tools label for now; “Services” or “Building blocks” are possible UI naming
alternatives for later owner review, not a silent rename to resolve MCP terminology overlap.
Do not overload manifest `role`, client action permissions or Docker Linux
`capabilities` to represent product functionality. Classification grants no additional authority.

## Authoring Workflow

While planning a new app or extending an existing one, the agent identifies needed capabilities
and searches Marketplace for components that can supply them, then separately checks accessible
installed providers through Core discovery. Repeat discovery when requirements reveal another
useful dependency, rather than limiting it to the import/wrapping step. Compare actual need,
version/API compatibility, host/runtime support, configuration and identity requirements. A matching
name is a candidate, not proof of interchangeability. Catalog availability, installed state and
usable/running/configured state are separate facts.

When candidates fit, explain which requested functions each supplies, what the new app still needs
to implement, and relevant limitations or alternatives. For example, propose Transcode Engine as
a provider for verified video-processing operations, without presenting it as a complete video
editor. Offer to connect an appropriate installed provider or follow the existing installation
flow for the catalog app. Keep
creating an adaptation available when there is a concrete mismatch or the user explicitly wants
a separate implementation. Discovery does not automatically install, grant access, change a
dependency or submit a catalog entry. Record the chosen app/feed/version and why it fits or was
rejected in the authoring session.

A database/provider app is not automatically a manifest `role: system` app. That reserved role
and its access implications remain governed by the existing app contract. Reuse also does not
imply sharing production data: database/user/namespace provisioning and grants need the provider's
supported contract. Sandbox validation resolves sandbox providers or explicit mocks and must not
fall back to a production instance just because it is already installed.

If Marketplace is unavailable, disabled, unauthorized or has incomplete metadata, report the
discovery limit. Distinguish a successful search with no matches from an unperformed/failed search;
never claim there is no existing app on that basis. Catalog text is descriptive input, not authority
to run commands or broaden permissions.

## Ownership

- This plan owns Marketplace read-only MCP discovery, its metadata and access contract.
- [App authoring](../app-authoring/plan.md) owns when the agent searches, compares and proposes reuse.
- [App publication](../app-publication/plan.md) owns release/feed and catalog-submission actions;
  write tools, if introduced there, remain separate from discovery permissions.
- Core and [cross-app dependencies](../cross-app-dependencies/plan.md) own installed-provider state,
  lifecycle and connection contracts. Reuse them without duplicating those deliverables.

## Deliverables

- [ ] Define and implement paginated read-only search and detail MCP tools using Marketplace's
  configured catalog and feed resolution, with provenance, freshness and explicit unknown fields.
- [ ] Expose the app-owned MCP interface through existing discovery and authenticated scoped access;
  preserve current administrator-only Marketplace access unless a separate policy is approved.
- [ ] Specify capability/operation and interface metadata needed to find and compare reusable
  providers by user need, including partial matches, constraints, evidence and upstream identities;
  use existing fields where sufficient and design necessary additive contract changes explicitly.
- [ ] Define and expose the Tools classification in catalog discovery/details and storefront filters,
  independently of system role, UI presence and whether the provider exposes MCP.
- [ ] Integrate the authoring reuse workflow with Core installed-provider discovery and existing
  installation handoff; show reasons for reuse, adaptation or an unresolved compatibility result.
- [ ] Verify the acceptance cases below and document shipped behavior in `feature.md`.

## Phases And Open Questions

First establish search/detail and authentication, then integrate authoring and provider matching.
Which metadata supports a first video-editor-to-provider search without naming an app, as well as
a MongoDB-like exact match? How should Tools classification be stored and displayed for apps with
both user-facing and provider functions? How are upstream aliases and version
constraints represented? Which MCP read scopes and tool limits fit existing app authentication?
Where is compatibility checked when a provider requires database provisioning rather than just a
dependency URL? Resolve these before Ready; no fuzzy match should silently become a binding.

## Verification

Cover a video-editor request with no provider name: find candidates by documented functionality,
explain partial coverage and reject unsupported claimed operations. Verify Tools filtering includes
service providers without escalating them to system apps and supports providers with optional UI.
Also cover an exact suitable catalog app, an installed compatible provider, a same-name incompatible
candidate, an unconfigured provider, no matches, pagination and unavailable/stale catalog data.
Verify unauthorized calls cannot disclose catalog or host state, search performs no lifecycle
mutation, and sandbox requests cannot select production providers implicitly. End-to-end authoring
should recommend an existing wrapper before generating a duplicate while preserving an explicitly
requested alternative and recording the decision. Documentation-only planning requires index,
local-link and whitespace checks; no runtime behavior is implemented by this Draft.
