import assert from "node:assert/strict";
import { writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { build } from "vite";

/** Published consumer: Node SSR followed by its independently bundled browser code. */
export async function verifyChromeHydration(directory, repositoryRoot) {
  writeFileSync(join(directory, "view.mjs"), `
import { createElement, StrictMode } from "react";
import { InstallDialog } from "@hosty-sdk/app/install/react";
const client = { prepare() { throw new Error("Unexpected installation"); }, submit() { throw new Error("Unexpected submission"); }, status() { throw new Error("Unexpected status request"); } };
export function View({ extra = true } = {}) {
  return createElement(StrictMode, null, createElement("section", null,
    createElement("input", { "aria-label": "App draft", defaultValue: "Saved text" }),
    createElement(InstallDialog, { client, onClose() {} }),
    extra && createElement(InstallDialog, { client, onClose() {} })));
}
`);
  writeFileSync(join(directory, "server.mjs"), `
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { View } from "./view.mjs";
console.log(renderToString(createElement(View)));
`);
  const html = execFileSync(process.execPath, ["server.mjs"], { cwd: directory, encoding: "utf8" }).trim();
  assert.ok(!html.includes("file:") && !html.includes("@font-face") && !html.includes(directory));
  writeFileSync(join(directory, "server.html"), html);
  writeFileSync(join(directory, "browser.mjs"), `
import { createElement } from "react";
import { hydrateRoot } from "react-dom/client";
import { View } from "./view.mjs";
const errors = [];
const root = hydrateRoot(document.getElementById("root"), createElement(View), { onRecoverableError(error) { errors.push(String(error)); } });
window.sdkFixture = { errors, replay(extra) { root.render(createElement(View, { extra })); }, unmount() { root.unmount(); } };
`);
  await build({ configFile: false, root: directory, logLevel: "silent", build: {
    outDir: "browser-output", assetsInlineLimit: 0,
    rollupOptions: { input: join(directory, "browser.mjs"), output: { inlineDynamicImports: true } },
  } });
  const assetsDirectory = join(directory, "browser-output/assets");
  const files = readdirSync(assetsDirectory);
  const fonts = files.filter(file => file.endsWith(".woff2"));
  assert.equal(fonts.length, 6);
  const entry = files.find(file => file.endsWith(".js"));
  assert.ok(entry);
  const javascript = readFileSync(join(assetsDirectory, entry), "utf8");
  assert.ok(!javascript.includes("file:") && !javascript.includes(directory));
  for (const font of fonts) assert.ok(javascript.includes(font));
  writeFileSync(join(directory, "browser-check.mjs"), `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SourceTextModule } from "node:vm";
import { JSDOM, VirtualConsole } from ${JSON.stringify(pathToFileURL(join(repositoryRoot, "node_modules/jsdom/lib/api.js")).href)};
const diagnostics = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on("error", (...args) => diagnostics.push(args.join(" ")));
virtualConsole.on("jsdomError", error => diagnostics.push(String(error)));
const html = readFileSync("server.html", "utf8");
assert.ok(!html.includes("file:") && !html.includes("@font-face"));
const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root">' + html + '</div></body></html>', { url: "https://sdk-fixture.example/", runScripts: "outside-only", virtualConsole });
try {
  const { window } = dom;
  window.HTMLDialogElement.prototype.showModal = function() { this.setAttribute("open", ""); };
  window.HTMLDialogElement.prototype.close = function() { this.removeAttribute("open"); };
  const draft = window.document.querySelector('[aria-label="App draft"]');
  draft.value = "Typed before hydration";
  const module = new SourceTextModule(readFileSync(${JSON.stringify(join(assetsDirectory, entry))}, "utf8"), { context: dom.getInternalVMContext(), initializeImportMeta(meta) { meta.url = ${JSON.stringify("https://sdk-fixture.example/assets/" + entry)}; } });
  await module.link(() => { throw new Error("Unexpected external browser import"); });
  await module.evaluate();
  const settle = () => new Promise(resolve => setTimeout(resolve, 50));
  await settle();
  const sheets = () => window.document.head.querySelectorAll('[data-hosty-sdk-fonts]');
  assert.equal(sheets().length, 1);
  const sheet = sheets()[0];
  const urls = [...sheet.textContent.matchAll(/url[(]"([^"]+)"[)]/g)].map(match => new URL(match[1]));
  assert.equal(urls.length, 6);
  for (const url of urls) { assert.equal(url.protocol, "https:"); assert.equal(url.origin, "https://sdk-fixture.example"); assert.ok(${JSON.stringify(fonts)}.some(font => url.pathname.endsWith(font))); }
  assert.equal(window.document.querySelector('[aria-label="App draft"]'), draft);
  assert.equal(draft.value, "Typed before hydration");
  assert.equal(window.sdkFixture.errors.length, 0);
  assert.deepEqual(diagnostics, []);
  window.sdkFixture.replay(false); await settle(); assert.equal(sheets()[0], sheet);
  window.sdkFixture.replay(true); await settle(); assert.equal(sheets().length, 1); assert.equal(sheets()[0], sheet);
  assert.equal(window.sdkFixture.errors.length, 0); assert.deepEqual(diagnostics, []);
  window.sdkFixture.unmount(); await settle(); assert.equal(sheets().length, 0);
  console.log("Published SDK hydration OK: deterministic SSR, retained app input, no hydration errors, one replay-safe font sheet, six HTTPS font assets.");
} finally { dom.window.close(); }
`);
  const result = execFileSync(process.execPath, ["--experimental-vm-modules", "browser-check.mjs"], { cwd: directory, encoding: "utf8" });
  console.log(result.trim());
}
