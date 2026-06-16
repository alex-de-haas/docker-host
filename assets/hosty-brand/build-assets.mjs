#!/usr/bin/env node
// Hosty brand asset generator.
//
// Single source of truth for the Hosty "H-graph" logomark. Writes the SVG
// masters (assets/hosty-brand/svg/), the app-facing SVGs (apps/shell/public/),
// and rasterizes every PNG + the multi-size favicon.ico from those SVGs so the
// whole library stays in sync with one flat color geometry.
//
//   node assets/hosty-brand/build-assets.mjs
//
// Requires `sharp` (already a repo dependency).

import sharp from "sharp";
import { mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRAND = __dirname; // assets/hosty-brand
const REPO = join(BRAND, "..", "..");
const SHELL_PUBLIC = join(REPO, "apps", "shell", "public");

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------
const C = {
  ink: "#0F1B2D", // dark mark / dark surface
  offWhite: "#F8FAFC", // mark on dark
  white: "#FFFFFF",
  blue: "#1C68FF", // brand tile
  cyan: "#28D5E5",
  darkSurface: "#0F1B2D",
};

// ---------------------------------------------------------------------------
// The mark. viewBox 0 0 100 100. Five rounded-square outlined nodes
// (4 corners + center) wired into the letter "H".
// ---------------------------------------------------------------------------
function markBody(color, sw = 6, cls) {
  // `color` is kept as a presentation attribute so renderers that ignore
  // <style> (e.g. the PNG/ICO rasterizer) still get a stroke; an optional
  // class lets a stylesheet override it (theme-aware favicon).
  const clsAttr = cls ? ` class="${cls}"` : "";
  return `
    <g fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"${clsAttr}>
      <path d="M25 36 V64 M75 36 V64 M25 50 H39 M61 50 H75"/>
      <rect x="17" y="17" width="16" height="16" rx="4.5"/>
      <rect x="67" y="17" width="16" height="16" rx="4.5"/>
      <rect x="17" y="67" width="16" height="16" rx="4.5"/>
      <rect x="67" y="67" width="16" height="16" rx="4.5"/>
      <rect x="42" y="42" width="16" height="16" rx="4.5"/>
    </g>`;
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
      `<g transform="translate(50 50) scale(${scale}) translate(-50 -50)">${markBody(color)}</g>`,
  );

// Favicon: transparent background, theme-aware via prefers-color-scheme. The
// mark is ink under a light browser theme (reads on light tab bars) and flips
// to off-white under a dark theme. The ink presentation attribute mirrors the
// light-theme look, so the rasterized .ico/PNG fallbacks (which can't honor the
// media query) render a dark mark on transparent.
const favicon = (scale = 1.16) =>
  svg(
    "0 0 100 100",
    `<style>` +
      `.hosty-mark{stroke:${C.ink}}` +
      `@media(prefers-color-scheme:dark){.hosty-mark{stroke:${C.offWhite}}}` +
      `</style>` +
      `<g transform="translate(50 50) scale(${scale}) translate(-50 -50)">` +
      markBody(C.ink, 6, "hosty-mark") +
      `</g>`,
  );

// Horizontal lockup: mark + "Hosty" wordmark, tightly framed. The viewBox
// width is computed from the measured wordmark width so framing stays balanced.
const WORDMARK = {
  fontFamily: "Inter, 'Helvetica Neue', Arial, sans-serif",
  fontSize: 52,
  fontWeight: 600,
  letterSpacing: -1.5,
  text: "Hosty",
};
const LOCKUP = { markScale: 0.76, markX: 6, gap: 16, pad: 6, height: 100 };

// Measure the rendered wordmark width (px) at the exact type settings.
async function measureWordmark() {
  const { fontFamily, fontSize, fontWeight, letterSpacing, text } = WORDMARK;
  const probe = svg(
    "0 0 600 200",
    `<text x="10" y="100" dominant-baseline="central" font-family="${fontFamily}" ` +
      `font-size="${fontSize}" font-weight="${fontWeight}" letter-spacing="${letterSpacing}" ` +
      `fill="#000">${text}</text>`,
  );
  const { data, info } = await sharp(Buffer.from(probe))
    .resize(600, 200)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels } = info;
  let minx = W, maxx = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (data[(y * W + x) * channels + 3] > 20) {
        if (x < minx) minx = x;
        if (x > maxx) maxx = x;
      }
    }
  }
  return maxx - minx + 1;
}

function horizontal(color, textWidth, bg) {
  const { markScale, markX, gap, pad, height } = LOCKUP;
  const markY = (height - 100 * markScale) / 2;
  const textX = markX + 100 * markScale + gap;
  const vbWidth = Math.round(textX + textWidth + pad);
  const { fontFamily, fontSize, fontWeight, letterSpacing, text } = WORDMARK;
  const bgEl = bg ? `<rect width="${vbWidth}" height="${height}" fill="${bg}"/>` : "";
  return svg(
    `0 0 ${vbWidth} ${height}`,
    `${bgEl}` +
      `<g transform="translate(${markX} ${markY}) scale(${markScale})">${markBody(color)}</g>` +
      `<text x="${textX}" y="${height / 2}" dominant-baseline="central" ` +
      `font-family="${fontFamily}" font-size="${fontSize}" font-weight="${fontWeight}" ` +
      `letter-spacing="${letterSpacing}" fill="${color}">${text}</text>`,
  );
}

// ---------------------------------------------------------------------------
// SVG masters (the horizontal lockups are sized after measuring the wordmark).
// ---------------------------------------------------------------------------
const SVG_DIR = join(BRAND, "svg");

async function buildMasters() {
  const w = await measureWordmark();
  return {
    "hosty-mark-light.svg": markOnly(C.ink), // dark mark for light backgrounds
    "hosty-mark-dark.svg": markOnly(C.offWhite), // light mark for dark backgrounds
    "hosty-icon-brand.svg": tile(C.blue, C.offWhite),
    "hosty-icon-light.svg": tile(C.white, C.ink),
    "hosty-icon-dark.svg": tile(C.ink, C.offWhite),
    "hosty-favicon.svg": favicon(),
    "hosty-logo-horizontal-light.svg": horizontal(C.ink, w),
    "hosty-logo-horizontal-dark.svg": horizontal(C.offWhite, w),
    "hosty-logo-horizontal-on-white.svg": horizontal(C.ink, w, C.white),
  };
}

// ---------------------------------------------------------------------------
// Rasterize helpers
// ---------------------------------------------------------------------------
const png = (svgStr, w, h = w) =>
  sharp(Buffer.from(svgStr)).resize(w, h).png().toBuffer();

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

// Rasterize an SVG to PNG at a fixed height, preserving its aspect ratio.
const pngH = (svgStr, h) =>
  sharp(Buffer.from(svgStr)).resize({ height: h }).png().toBuffer();

async function run() {
  const masters = await buildMasters();
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
  writeFileSync(join(SHELL_PUBLIC, "favicon.ico"), ico);
  writeFileSync(join(SHELL_PUBLIC, "apple-touch-icon.png"), await png(masters["hosty-icon-brand.svg"], 180));

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

  console.log("Brand assets generated.");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
