// Run after build. Exercises the published package layout with unchanged consumer source.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verifyChromeHydration } from "./check-chrome-hydration.mjs";

const sdk = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(sdk, "../..");
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "hosty-overlay-upgrade-")));
// This consumer has no SDK-internal import, copy of the UI, or app-side presentation prop.
const consumer = `
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HostyOverlay } from "@hosty-sdk/app/react";
import { createHostySessionResponse } from "@hosty-sdk/app/session/server";
const markup = renderToStaticMarkup(createElement(HostyOverlay, null, "PROTECTED_CONTENT"));
const response = await createHostySessionResponse({status: "not-present"}, {
  appId: "fixture", corePublicOrigin: "https://core.example.test", appAuthProtocol: 2
});
console.log(JSON.stringify({markup, session: await response.json()}));
`;
try {
  const outputs = [];
  for (const revision of ["baseline", "update"]) {
    const directory = join(sandbox, revision);
    const dependency = join(directory, "node_modules/@hosty-sdk/app");
    mkdirSync(dependency, { recursive: true });
    cpSync(join(sdk, "dist"), join(dependency, "dist"), { recursive: true });
    const pkg = JSON.parse(readFileSync(join(sdk, "package.json"), "utf8"));
    pkg.exports = Object.fromEntries(Object.entries(pkg.exports).map(([key, source]) =>
      [key, source.replace("./src/", "./dist/").replace(/\.tsx?$/, ".js")]));
    writeFileSync(join(dependency, "package.json"), JSON.stringify(pkg));
    for (const name of ["react", "react-dom", "@noble"]) {
      symlinkSync(join(root, "node_modules", name), join(directory, "node_modules", name), "dir");
    }
    if (revision === "update") {
      // Model a compatible SDK-owned palette revision in the dependency only.
      for (const name of ["sdk-chrome.js", "overlay-react.js"]) {
        const file = join(dependency, "dist", name);
        const source = readFileSync(file, "utf8");
        assert.ok(source.includes("#F6F8FB"));
        writeFileSync(file, source.replaceAll("#F6F8FB", "#F5F7FA"));
      }
    }
    writeFileSync(join(directory, "consumer.mjs"), consumer);
    const output = JSON.parse(execFileSync(process.execPath, ["consumer.mjs"], { cwd: directory, encoding: "utf8" }));
    assert.ok(!output.markup.includes("PROTECTED_CONTENT"));
    assert.ok(!output.markup.includes("file:") && !output.markup.includes(sdk));
    assert.ok(!output.markup.includes("@font-face"), "Module-relative font URLs must not be serialized by SSR");
    assert.equal(output.session.status, "not-present");
    outputs.push(output);
    for (const file of ["plex-sans-latin.woff2", "plex-sans-latin-ext.woff2", "plex-sans-cyrillic.woff2",
      "jetbrains-mono-latin.woff2", "jetbrains-mono-latin-ext.woff2", "jetbrains-mono-cyrillic.woff2",
      "plex-sans-LICENSE.txt", "jetbrains-mono-LICENSE.txt"]) {
      assert.ok(existsSync(join(dependency, "dist/assets", file)), `Published SDK asset missing: ${file}`);
    }
    if (revision === "baseline") await verifyChromeHydration(directory, root);
  }
  assert.notEqual(outputs[0].markup, outputs[1].markup);
  assert.equal(outputs[0].markup.replaceAll("#F6F8FB", "#F5F7FA"), outputs[1].markup);
  assert.equal(readFileSync(join(sandbox, "baseline/consumer.mjs"), "utf8"), readFileSync(join(sandbox, "update/consumer.mjs"), "utf8"));
  const packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: sdk, encoding: "utf8" }))[0];
  const included = new Set(packed.files.map(file => file.path));
  for (const file of readdirSync(join(sdk, "dist/assets"))) assert.ok(included.has(`dist/assets/${file}`), `npm package omits ${file}`);
  console.log("Overlay upgrade contract OK: unchanged consumer, published exports, dependency-owned presentation, bundled browser fonts and npm assets/licenses.");
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
