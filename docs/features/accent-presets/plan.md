---
status: On Hold
created: 2026-10-12
updated: 2026-10-13
summary: A per-user brand color preset chosen like the light or dark theme and carried to embedded apps; parked while ink and lime stay fixed.
components: [apps/shell, packages/app-sdk]
---

# Accent Presets

## Goal

Let each user pick Hosty's brand color — the lime that answers hover, focus and selection — from a few
prepared presets, the way they pick the light or dark theme today, and have embedded apps follow the
choice.

## Status

On hold since 2026-10-12. On 2026-10-13 the owner made ink the action color and lime `#A3E635` the
interaction color for everyone (see [Design System](../design-system/plan.md)); `--primary` stays ink
whatever the preset. The earlier candidates — Iris, Sapphire, Ink, Lagoon — were action colors for the
blue era and are no longer on the canvas; new candidates would be drawn as brand colors.

## Target Behavior

- Presets only, never a free color, with lime as the default.
- A preset is a bundle, not one value: `--brand`, `--brand-foreground`, `--brand-strong`, `--ring`,
  `--accent` and `--sidebar-accent` with their foregrounds, and the selection wash, each pair
  contrast-checked. No preset may sit next to the cyan signal or the status colors.
- The choice is a personal preference stored like the theme preference and applied with a
  `data-accent` attribute on the document root.
- Embedded apps receive it through the `@hosty-sdk/app/theme` protocol, beside the existing
  `hosty:shell-theme` message, `hosty_theme` parameter and `data-hosty-theme` attribute.

## Deliverables

- [ ] D1. Define the preset bundles as CSS variable sets and add an accent choice beside the theme in Shell, stored per user like the theme preference.
- [ ] D2. Carry the accent through the `@hosty-sdk/app/theme` protocol and apply it in first-party apps.

## Open Questions

- Which brand presets ship besides lime?

## Verification

- Contrast checks for every preset's text and fill pairs in light and dark.
- An embedded app follows an accent change without a reload, as it does for the theme.
