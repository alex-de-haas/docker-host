// Run after build. Exercises the published package layout with unchanged consumer source.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const sdk = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(sdk, "../..");
const sandbox = mkdtempSync(join(tmpdir(), "hosty-overlay-upgrade-"));
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
      const file = join(dependency, "dist/overlay-react.js");
      const source = readFileSync(file, "utf8");
      assert.ok(source.includes("#f8f9fb"));
      writeFileSync(file, source.replaceAll("#f8f9fb", "#f7f8fa"));
    }
    writeFileSync(join(directory, "consumer.mjs"), consumer);
    const output = JSON.parse(execFileSync(process.execPath, ["consumer.mjs"], { cwd: directory, encoding: "utf8" }));
    assert.ok(!output.markup.includes("PROTECTED_CONTENT"));
    assert.equal(output.session.status, "not-present");
    outputs.push(output);
  }
  assert.notEqual(outputs[0].markup, outputs[1].markup);
  assert.equal(outputs[0].markup.replaceAll("#f8f9fb", "#f7f8fa"), outputs[1].markup);
  assert.equal(readFileSync(join(sandbox, "baseline/consumer.mjs"), "utf8"), readFileSync(join(sandbox, "update/consumer.mjs"), "utf8"));
  console.log("Overlay upgrade contract OK: unchanged consumer, published exports, dependency-owned presentation.");
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
