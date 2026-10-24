#!/usr/bin/env node
// Hosty brand asset generator.
//
// Generates the seven-cell Hosty mark from the shared SDK geometry. Writes the SVG
// masters (assets/hosty-brand/svg/), the browser Shell assets, and the native
// Swift app icons. It rasterizes every PNG + the multi-size favicon.ico from
// those SVGs so the whole library stays in sync with the canonical grid.
//
//   node assets/hosty-brand/build-assets.mjs --web-only
//
// Requires `sharp` (already a repo dependency).

import sharp from "sharp";
import { mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { CORE_MARK } from "../../packages/app-sdk/src/core-mark-geometry.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRAND = __dirname; // assets/hosty-brand
const webOnly = process.argv.includes("--web-only");
if (process.argv.slice(2).some((argument) => argument !== "--web-only")) {
  throw new Error("Usage: node assets/hosty-brand/build-assets.mjs [--web-only]");
}
const REPO = join(BRAND, "..", "..");
const SHELL_PUBLIC = join(REPO, "apps", "shell", "public");
const SWIFT_APP_ICONS = join(
  REPO,
  "apps",
  "shell-swift",
  "Hosty",
  "Assets.xcassets",
  "AppIcon.appiconset",
);

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------
const C = {
  ink: "#0F1B2D", // dark mark / dark surface
  offWhite: "#F8FAFC", // mark on dark
  white: "#FFFFFF",
  lime: CORE_MARK.accent,
  darkTile: "#22324B",
  darkSurface: "#0F1B2D",
};

// ---------------------------------------------------------------------------
// The mark. Seven sharp square cells in the shared 100-unit grid.
// ---------------------------------------------------------------------------
function markBody(color, tiled = false, cls) {
  const { size, gap, inset } = tiled ? CORE_MARK.tile : CORE_MARK.plain;
  const clsAttr = cls ? ` class="${cls}"` : "";
  return CORE_MARK.cells.flatMap((row, y) => [...row].map((cell, x) => cell === "." ? "" :
    `<rect x="${inset + x * (size + gap)}" y="${inset + y * (size + gap)}" width="${size}" height="${size}" fill="${cell === "*" ? C.lime : color}"${cell === "*" ? "" : clsAttr}/>`)).join("");
}

const svg = (vb, inner) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}">${inner}\n</svg>\n`;

// Transparent logomark.
const markOnly = (color) => svg("0 0 100 100", markBody(color));

// Rounded-square app-icon tile with the mark centered.
const tile = (bg, color, scale = 1) =>
  svg(
    "0 0 100 100",
    `<rect width="100" height="100" rx="22" fill="${bg}"/>` +
      `<g transform="translate(50 50) scale(${scale}) translate(-50 -50)">${markBody(color, true)}</g>`,
  );

// iOS applies the platform mask itself, so its source artwork is square and
// opaque. Feeding it the rounded brand tile would create transparent corners
// and visually double-inset the icon on the Home Screen.
const platformTile = (bg, color, scale = 1) =>
  svg(
    "0 0 100 100",
    `<rect width="100" height="100" fill="${bg}"/>` +
      `<g transform="translate(50 50) scale(${scale}) translate(-50 -50)">${markBody(color, true)}</g>`,
  );

// Favicon: transparent background, theme-aware via prefers-color-scheme. The
// mark is ink under a light browser theme (reads on light tab bars) and flips
// to white under a dark theme. The ink presentation attribute mirrors the
// light-theme look, so the rasterized .ico/PNG fallbacks (which can't honor the
// media query) render a dark mark on transparent. Fixed light/dark SVGs let
// Shell follow a saved app theme without depending on browser media preferences.
const favicon = (theme = "system", scale = 1.16) =>
  svg(
    "0 0 100 100",
    (theme === "system" ? `<style>` +
      `.hosty-mark{fill:${C.ink}}` +
      `@media(prefers-color-scheme:dark){.hosty-mark{fill:${C.white}}}` +
      `</style>` : "") +
      `<g transform="translate(50 50) scale(${scale}) translate(-50 -50)">` +
      markBody(theme === "dark" ? C.white : C.ink, false, theme === "system" ? "hosty-mark" : undefined) +
      `</g>`,
  );

// Outlined IBM Plex Sans 600 paths come from the bundled, licensed font.
// Rerun outline-wordmark.py after a font change; no installed system font is used.
const WORDMARK = JSON.parse(readFileSync(join(BRAND, "wordmark.json"), "utf8"));
const fontBytes = readFileSync(join(REPO, WORDMARK.font));
if (createHash("sha256").update(fontBytes).digest("hex") !== WORDMARK.sha256) {
  throw new Error("Wordmark font changed. Regenerate outlines with outline-wordmark.py.");
}
const LOCKUP = { markScale: 0.76, markX: 6, gap: 16, pad: 10, height: 100 };

function horizontal(color, bg) {
  const { markScale, markX, gap, pad, height } = LOCKUP;
  const markY = (height - 100 * markScale) / 2;
  const textX = markX + 100 * markScale + gap;
  const scale = 52 / WORDMARK.unitsPerEm;
  const width = Math.ceil(textX + WORDMARK.advance * scale + pad);
  const baseline = height / 2 + (WORDMARK.bounds.yMin + WORDMARK.bounds.yMax) * scale / 2;
  const bgEl = bg ? `<rect width="${width}" height="${height}" fill="${bg}"/>` : "";
  return svg(`0 0 ${width} ${height}`, `${bgEl}` +
    `<g transform="translate(${markX} ${markY}) scale(${markScale})">${markBody(color)}</g>` +
    `<g fill="${color}" transform="translate(${textX} ${baseline}) scale(${scale} ${-scale})">` +
    WORDMARK.glyphs.map(({ x, path }) => `<path transform="translate(${x} 0)" d="${path}"/>`).join("") + `</g>`);
}

// ---------------------------------------------------------------------------
// SVG masters
// ---------------------------------------------------------------------------
const SVG_DIR = join(BRAND, "svg");

function buildMasters() {
  return {
    "hosty-mark-light.svg": markOnly(C.ink), // dark mark for light backgrounds
    "hosty-mark-dark.svg": markOnly(C.white), // light mark for dark backgrounds
    "hosty-icon-brand.svg": tile(C.ink, C.white),
    "hosty-icon-light.svg": tile(C.ink, C.white),
    "hosty-icon-dark.svg": tile(C.ink, C.white),
    "hosty-favicon.svg": favicon(),
    "hosty-favicon-light.svg": favicon("light"),
    "hosty-favicon-dark.svg": favicon("dark"),
    "hosty-logo-horizontal-light.svg": horizontal(C.ink),
    "hosty-logo-horizontal-dark.svg": horizontal(C.white),
    "hosty-logo-horizontal-on-white.svg": horizontal(C.ink, C.white),
  };
}

// ---------------------------------------------------------------------------
// Rasterize helpers
// ---------------------------------------------------------------------------
const png = (svgStr, w, h = w) =>
  sharp(Buffer.from(svgStr)).resize(w, h).png().toBuffer();

const opaquePng = (svgStr, w, h = w) =>
  sharp(Buffer.from(svgStr)).resize(w, h).removeAlpha().png().toBuffer();

function cleanPngs(dir) {
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) {
    if (f.endsWith(".png") || f.endsWith(".ico")) rmSync(join(dir, f));
  }
}

// Minimal ICO encoder: container of PNG-encoded images.
function buildIco(entries) {
  // entries: [{ size, buffer }]
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);

  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  const dataChunks = [];
  entries.forEach((e, i) => {
    const o = i * 16;
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, o + 0); // width (0 => 256)
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, o + 1); // height
    dir.writeUInt8(0, o + 2); // palette
    dir.writeUInt8(0, o + 3); // reserved
    dir.writeUInt16LE(1, o + 4); // color planes
    dir.writeUInt16LE(32, o + 6); // bits per pixel
    dir.writeUInt32LE(e.buffer.length, o + 8); // size of data
    dir.writeUInt32LE(offset, o + 12); // offset
    offset += e.buffer.length;
    dataChunks.push(e.buffer);
  });
  return Buffer.concat([header, dir, ...dataChunks]);
}

// ---------------------------------------------------------------------------
// Generate everything
// ---------------------------------------------------------------------------
const ICON_SIZES = [16, 20, 24, 32, 48, 64, 96, 128, 256, 512];
const FAVICON_SIZES = [16, 32, 48, 64, 128, 256];
const MAC_APP_ICON_SLOTS = [
  [16, 1],
  [16, 2],
  [32, 1],
  [32, 2],
  [128, 1],
  [128, 2],
  [256, 1],
  [256, 2],
  [512, 1],
  [512, 2],
];

// Rasterize an SVG to PNG at a fixed height, preserving its aspect ratio.
const pngH = (svgStr, h) =>
  sharp(Buffer.from(svgStr)).resize({ height: h }).png().toBuffer();

async function run() {
  const masters = buildMasters();
  mkdirSync(SVG_DIR, { recursive: true });
  for (const [name, content] of Object.entries(masters)) {
    writeFileSync(join(SVG_DIR, name), content);
  }

  // Icons (transparent marks) — light = dark mark, dark = light mark.
  const iconLight = join(BRAND, "icons", "light");
  const iconDark = join(BRAND, "icons", "dark");
  cleanPngs(iconLight);
  cleanPngs(iconDark);
  for (const s of ICON_SIZES) {
    writeFileSync(join(iconLight, `hosty-icon-light-${s}.png`), await png(masters["hosty-mark-light.svg"], s));
    writeFileSync(join(iconDark, `hosty-icon-dark-${s}.png`), await png(masters["hosty-mark-dark.svg"], s));
  }

  // Favicon PNGs + ICO (brand tile).
  const favDir = join(BRAND, "favicon");
  cleanPngs(favDir);
  const favSvg = masters["hosty-favicon.svg"];
  const icoEntries = [];
  for (const s of FAVICON_SIZES) {
    const buf = await png(favSvg, s);
    writeFileSync(join(favDir, `favicon-${s}.png`), buf);
    icoEntries.push({ size: s, buffer: buf });
  }
  const ico = buildIco(icoEntries);
  writeFileSync(join(favDir, "favicon.ico"), ico);
  writeFileSync(join(BRAND, "favicon.ico"), ico);

  // Logos.
  const logos = join(BRAND, "logos");
  cleanPngs(logos);
  writeFileSync(join(logos, "hosty-mark-ink-512.png"), await png(masters["hosty-mark-light.svg"], 512));
  writeFileSync(join(logos, "hosty-mark-white-512.png"), await png(masters["hosty-mark-dark.svg"], 512));
  writeFileSync(join(logos, "hosty-icon-brand-512.png"), await png(masters["hosty-icon-brand.svg"], 512));
  writeFileSync(join(logos, "hosty-icon-brand-1024.png"), await png(masters["hosty-icon-brand.svg"], 1024));
  writeFileSync(join(logos, "hosty-logo-horizontal-light.png"), await pngH(masters["hosty-logo-horizontal-light.svg"], 300));
  writeFileSync(join(logos, "hosty-logo-horizontal-dark.png"), await pngH(masters["hosty-logo-horizontal-dark.svg"], 300));
  writeFileSync(join(logos, "hosty-logo-horizontal-on-white.png"), await pngH(masters["hosty-logo-horizontal-on-white.svg"], 300));

  // App-facing assets in the shell.
  mkdirSync(SHELL_PUBLIC, { recursive: true });
  writeFileSync(join(SHELL_PUBLIC, "favicon.svg"), favSvg);
  writeFileSync(join(SHELL_PUBLIC, "favicon-light.svg"), masters["hosty-favicon-light.svg"]);
  writeFileSync(join(SHELL_PUBLIC, "favicon-dark.svg"), masters["hosty-favicon-dark.svg"]);
  writeFileSync(join(SHELL_PUBLIC, "favicon.ico"), ico);
  writeFileSync(join(SHELL_PUBLIC, "apple-touch-icon.png"), await png(masters["hosty-icon-brand.svg"], 180));

  if (!webOnly) {
    // Native app icons. iOS gets explicit light, dark, and tinted variants; macOS gets the existing
    // rounded brand tile at every catalog size because macOS does not apply the iOS icon mask.
    mkdirSync(SWIFT_APP_ICONS, { recursive: true });
    for (const file of readdirSync(SWIFT_APP_ICONS)) {
      if (file.startsWith("HostyAppIcon-") && file.endsWith(".png")) {
        rmSync(join(SWIFT_APP_ICONS, file));
      }
    }

    writeFileSync(
      join(SWIFT_APP_ICONS, "HostyAppIcon-iOS.png"),
      await opaquePng(platformTile(C.ink, C.white), 1024),
    );
    writeFileSync(
      join(SWIFT_APP_ICONS, "HostyAppIcon-iOS-dark.png"),
      await opaquePng(platformTile(C.ink, C.offWhite), 1024),
    );
    writeFileSync(
      join(SWIFT_APP_ICONS, "HostyAppIcon-iOS-tinted.png"),
      await opaquePng(platformTile(C.white, C.ink), 1024),
    );

    for (const [points, scale] of MAC_APP_ICON_SLOTS) {
      const pixels = points * scale;
      writeFileSync(
        join(SWIFT_APP_ICONS, `HostyAppIcon-mac-${points}@${scale}x.png`),
        await png(masters["hosty-icon-brand.svg"], pixels),
      );
    }

  }

  // Preview contact sheet.
  const swatch = async (svgStr, size = 200) => png(svgStr, size);
  const cells = [
    { svg: masters["hosty-icon-brand.svg"], label: "brand" },
    { svg: masters["hosty-icon-dark.svg"], label: "dark" },
    { svg: masters["hosty-icon-light.svg"], label: "light" },
    { svg: masters["hosty-mark-light.svg"], label: "mark" },
  ];
  const SZ = 200, GAP = 40, PAD = 40;
  const W = PAD * 2 + cells.length * SZ + (cells.length - 1) * GAP;
  const H = PAD * 2 + SZ;
  const comps = [];
  for (let i = 0; i < cells.length; i++) {
    comps.push({ input: await swatch(cells[i].svg, SZ), left: PAD + i * (SZ + GAP), top: PAD });
  }
  await sharp({ create: { width: W, height: H, channels: 4, background: "#E2E8F0" } })
    .composite(comps)
    .png()
    .toFile(join(BRAND, "preview.png"));

  console.log(`Brand assets generated${webOnly ? " (web only; native icons preserved)" : ""}.`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
