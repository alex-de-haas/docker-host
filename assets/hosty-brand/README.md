# Hosty Brand Assets

The Hosty logomark is the **H-graph**: five rounded-square nodes (four corners
plus a center) wired together into the letter **H**. It is a single flat color
(no gradients), so it renders crisply at every size and recolors for any theme.

SVG is the source of truth; every PNG and `favicon.ico` is generated from the
SVG masters by `build-assets.mjs`.

## Structure

```text
hosty-brand/
├── svg/             # SVG masters (source of truth)
│   ├── hosty-mark-light.svg            # ink mark, transparent (light bg)
│   ├── hosty-mark-dark.svg             # off-white mark, transparent (dark bg)
│   ├── hosty-icon-brand.svg            # brand-blue tile + white mark
│   ├── hosty-icon-light.svg            # white tile + ink mark
│   ├── hosty-icon-dark.svg             # dark tile + off-white mark
│   ├── hosty-favicon.svg               # theme-aware transparent mark (scaled for small sizes)
│   └── hosty-logo-horizontal-*.svg     # mark + wordmark (light / dark / on-white)
├── icons/
│   ├── light/       # PNG ink marks (transparent) for light backgrounds
│   └── dark/        # PNG off-white marks (transparent) for dark backgrounds
├── favicon/         # favicon PNG variants + favicon.ico
├── favicon.ico      # multi-size ICO in the root
├── logos/           # PNG marks, brand tile, and horizontal lockups
├── brand-tokens.json
├── build-assets.mjs # regenerates everything from the SVG masters
└── preview.png
```

## Regenerating

```bash
node assets/hosty-brand/build-assets.mjs
```

This rewrites the SVG masters, all PNG sizes, `favicon.ico`, the shell app's
`apps/shell/public/{favicon.svg,favicon.ico,apple-touch-icon.png}`, and the
preview sheet. Requires `sharp` (already a repo dependency).

## Colors

| Token       | Hex       | Use                                |
| ----------- | --------- | ---------------------------------- |
| ink         | `#0F1B2D` | dark mark / dark surface           |
| offWhite    | `#F8FAFC` | mark on dark backgrounds           |
| white       | `#FFFFFF` | light tile background              |
| blue        | `#1C68FF` | brand tile                         |
| cyan        | `#28D5E5` | accent                             |

## Sizes

- Icons: 16, 20, 24, 32, 48, 64, 96, 128, 256, 512 px (per theme).
- `favicon.ico`: 16, 32, 48, 64, 128, 256 px.

## Theme-aware favicon

`svg/hosty-favicon.svg` (served as the shell's `favicon.svg`) has a transparent
background and carries a `prefers-color-scheme` media query: the mark is ink
under a light browser theme (reads on light tab bars) and flips to off-white
under a dark theme. The SVG also sets a matching `stroke` presentation
attribute, so the rasterized `.ico` and favicon PNGs — which cannot honor the
media query — fall back to a dark (ink) mark on transparent. The media query
follows the OS/browser theme, not the app's own toggle.
