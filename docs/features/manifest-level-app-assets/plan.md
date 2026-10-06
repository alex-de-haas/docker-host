---
status: Draft
created: 2026-10-05
updated: 2026-10-05
summary: Show an installed app's markdown description and screenshots in Shell, and retire hand-hosted catalog assets.
components: [apps/shell]
---

# Manifest-Level App Assets — Installed-App Presentation

The asset contract, endpoint, vendoring and storefront rendering ship as described in
[feature.md](feature.md). Core already resolves `descriptionUrl` for every installed app, but Shell
renders it nowhere: the installed-app details dialog has no view for the long description. Carried
over from the legacy design document on 2026-10-05.

## Target Behavior

- The installed-app details dialog gains an About view that renders `descriptionUrl` with the same
  markdown rules as Marketplace: raw HTML as text, relative references resolved against the
  description's folder through the asset endpoint, external images as links.
- Whether the same view shows locally served screenshots is decided with the owner before it is
  built.

## Deliverables

- [ ] D1. About view in the installed-app details dialog rendering `descriptionUrl`, sharing
      Marketplace's markdown rules, with Shell tests for raw HTML, relative references and
      external images.
- [ ] D2. Owner decision on screenshots in the installed-app view, then the chosen behavior.
- [ ] D3. Remove the deprecated hand-hosted `apps/*/assets/` seed entries from `hosty-catalog`
      once every catalog app vendors its assets from its own repository.

## Open Questions

1. Should the installed-app view show screenshots, or only the description?

## Verification

- Open an installed app with a `descriptionFile` in Shell and see its rendered description;
  an app without one shows the inline description.
- `npm run shell:test` and `npm run shell:build` pass.
