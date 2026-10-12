---
status: On Hold
created: 2026-10-12
updated: 2026-10-12
summary: A per-user accent preset chosen like the light or dark theme and carried to embedded apps; parked while Hosty Blue stays the action color.
components: [apps/shell, packages/app-sdk]
---

# Accent Presets

## Goal

Let each user pick Hosty's action color from a few prepared presets, the way they pick the light or
dark theme today, and have embedded apps follow the choice.

## Status

On hold since 2026-10-12: the owner keeps Hosty Blue `#1C68FF` as the only action color for now. The
candidates are drawn on the `Accent` artboard of the Design canvas described in
[Design System](../design-system/plan.md).

## Target Behavior

- Presets only, never a free color: Hosty Blue (default), Iris `#5B5BD6`, Sapphire `#2F5BD3`, Ink
  `#0F1B2D` and Lagoon `#0B7C86`.
- A preset is a bundle, not one value: `--primary`, `--ring`, `--sidebar-accent` and its foreground,
  `--chart-1`, and the soft and wash tints, each pair contrast-checked. Lagoon sits next to the cyan
  signal, so its bundle also moves the signal to lime `#A3E635`.
- The choice is a personal preference stored like the theme preference and applied with a
  `data-accent` attribute on the document root.
- Embedded apps receive it through the `@hosty-sdk/app/theme` protocol, beside the existing
  `hosty:shell-theme` message, `hosty_theme` parameter and `data-hosty-theme` attribute.

## Deliverables

- [ ] D1. Define the preset bundles as CSS variable sets and add an accent choice beside the theme in Shell, stored per user like the theme preference.
- [ ] D2. Carry the accent through the `@hosty-sdk/app/theme` protocol and apply it in first-party apps.

## Open Questions

- Which presets ship besides Hosty Blue?

## Verification

- Contrast checks for every preset's text and fill pairs in light and dark.
- An embedded app follows an accent change without a reload, as it does for the theme.
