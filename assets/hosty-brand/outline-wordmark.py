#!/usr/bin/env python3
"""Outline the bundled IBM Plex Sans variable font at weight 600.

Requires fonttools[woff]==4.60.1. Run from any working directory.
"""
from pathlib import Path
import hashlib
import json
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.boundsPen import BoundsPen

brand = Path(__file__).resolve().parent
repo = brand.parent.parent
source = "shared/web/fonts/plex-sans-latin.woff2"
data = (repo / source).read_bytes()
font = instantiateVariableFont(TTFont(repo / source), {"wght": 600})
glyph_set = font.getGlyphSet()
cmap = font.getBestCmap()
glyphs = []
x = 0
bounds = []
for character in "Hosty":
    name = cmap[ord(character)]
    glyph = glyph_set[name]
    path_pen = SVGPathPen(glyph_set, ntos=lambda value: format(value, ".3f").rstrip("0").rstrip(".") if value else "0")
    glyph.draw(path_pen)
    bounds_pen = BoundsPen(glyph_set)
    glyph.draw(bounds_pen)
    x_min, y_min, x_max, y_max = bounds_pen.bounds
    bounds.append((x + x_min, y_min, x + x_max, y_max))
    glyphs.append({"x": x, "path": path_pen.getCommands()})
    x += glyph.width
outline = {
    "font": source,
    "sha256": hashlib.sha256(data).hexdigest(),
    "family": "IBM Plex Sans",
    "weight": 600,
    "text": "Hosty",
    "unitsPerEm": font["head"].unitsPerEm,
    "advance": x,
    "bounds": {"xMin": min(b[0] for b in bounds), "yMin": min(b[1] for b in bounds),
               "xMax": max(b[2] for b in bounds), "yMax": max(b[3] for b in bounds)},
    "glyphs": glyphs,
}
(brand / "wordmark.json").write_text(json.dumps(outline, indent=2) + "\n")
print("Outlined Hosty in IBM Plex Sans 600 from the bundled font.")
