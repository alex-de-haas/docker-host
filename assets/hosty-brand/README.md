# Hosty Brand Assets

The Hosty mark is seven sharp square cells on a 3 × 3 grid: two hosts and the
lime Core between them. Six cells are ink on light backgrounds and white on
dark backgrounds. The center remains lime in both themes.

The canonical geometry lives in
[`core-mark-geometry.ts`](../../packages/app-sdk/src/core-mark-geometry.ts), shared
by SDK chrome, the Shell inline mark and this generator. Plain marks use 22-unit
cells, 7-unit gaps and a 10-unit inset in a 100-unit viewBox. App-icon tiles use
16-unit cells, 5.5-unit gaps and a 20.5-unit inset on an ink tile with radius 22.
Shell may render the tile one tone lighter on a dark surface; baked tiles remain ink.

The horizontal wordmark is **IBM Plex Sans 600**, outlined from the bundled font.
The SVGs contain paths rather than live text, so their appearance does not depend
on fonts installed on the viewing computer. The font license is retained in
[`shared/web/fonts`](../../shared/web/fonts/plex-sans-LICENSE.txt).

## Regenerating Web Assets

```bash
node assets/hosty-brand/build-assets.mjs --web-only
```

Requires Node.js 24 and the repository's `sharp` dependency. The command rewrites
the SVG masters, PNG variants, ICO, preview sheet and Shell public
`favicon.svg`, `favicon-light.svg`, `favicon-dark.svg`, `favicon.ico` and
`apple-touch-icon.png`. **`--web-only` preserves
every Swift AppIcon file.** Without that flag, the existing native generation
branch also runs; native outputs require their own approved scope and version change.

`wordmark.json` records the bundled font SHA-256, weight and glyph paths. The
generator refuses a changed font until the outlines are regenerated:

```bash
python3 -m venv /tmp/hosty-brand-fonttools
/tmp/hosty-brand-fonttools/bin/pip install 'fonttools[woff]==4.60.1'
/tmp/hosty-brand-fonttools/bin/python assets/hosty-brand/outline-wordmark.py
node assets/hosty-brand/build-assets.mjs --web-only
```

## Files And Colors

- `svg/`: generated transparent light/dark marks, ink tiles, theme-aware favicon
  and outlined horizontal lockups.
- `icons/light/` and `icons/dark/`: transparent PNG marks at 16, 20, 24, 32, 48,
  64, 96, 128, 256 and 512 px.
- `logos/`: transparent PNG marks, ink tiles and horizontal lockups.
- `favicon/` and `favicon.ico`: raster fallbacks at 16, 32, 48, 64, 128 and 256 px.
- `brand-tokens.json`: palette, geometry and stable asset names.
- `preview.html` and `preview.png`: light/dark inspection surfaces.

| Color | Hex | Use |
| --- | --- | --- |
| Ink | `#0F1B2D` | Light-surface cells and baked icon tile |
| White | `#FFFFFF` | Dark-surface and icon-tile cells |
| Lime | `#A3E635` | Core cell on every surface |
| Dark tile | `#22324B` | Inline tile on dark Shell surfaces |

The retained `hosty-icon-brand`, `hosty-icon-light` and `hosty-icon-dark` names all
refer to the same baked ink tile; they are compatibility aliases, not colored tiles.
The transparent SVG favicons use the 1.16 scale cut for small sizes. `favicon.svg`
follows the browser's light/dark preference before hydration. Shell then selects
`favicon-light.svg` or `favicon-dark.svg` from its resolved theme, including a saved
manual choice. Dark uses six white cells; light uses ink; both keep the lime Core.
The single SVG icon link avoids a competing fixed ICO in the document head.
PNG/ICO files remain direct-URL fallbacks with ink cells and a lime Core.
