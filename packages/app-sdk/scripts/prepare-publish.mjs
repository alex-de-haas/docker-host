// Publish-time transform: the repository's package.json points exports at TypeScript
// source (workspace consumers transpile it in place and always see the working tree);
// the published artifact must point at the built dist. Run after `npm run build`,
// immediately before `npm publish` — and never commit the result.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = join(packageDir, "package.json");

if (!existsSync(join(packageDir, "dist", "index.js"))) {
  console.error("dist/ is missing — run `npm run build` first.");
  process.exit(1);
}


// Refuse to publish a dist whose relative imports lack extensions: bundlers mask the
// breakage, but Node resolution (vitest, plain node) fails on it — exactly the defect the
// hand-built 0.1.0 and the chain-less 0.1.1 shipped. The build's fix-dist-extensions step
// must have run.
import { readdirSync } from "node:fs";
const distDir = join(packageDir, "dist");
for (const name of readdirSync(distDir)) {
  if (!/\.(js|d\.ts)$/.test(name)) continue;
  const content = readFileSync(join(distDir, name), "utf8");
  const bare = content.match(/from\s+"(\.\.?\/[^"]+?)"/g)?.filter((m) => !/\.(js|json)"/.test(m));
  if (bare && bare.length > 0) {
    console.error(`dist/${name} has extensionless relative imports (${bare[0]}) — run npm run build (with fix-dist-extensions).`);
    process.exit(1);
  }
}

const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
pkg.exports = Object.fromEntries(
  Object.entries(pkg.exports).map(([subpath, source]) => {
    if (typeof source !== "string") {
      // Already transformed (the script ran twice without a restore) — keep it as-is.
      return [subpath, source];
    }
    const stem = source.replace(/^\.\/src\//, "").replace(/\.(tsx|ts)$/, "");
    return [subpath, { types: `./dist/${stem}.d.ts`, default: `./dist/${stem}.js` }];
  }),
);
pkg.types = "./dist/index.d.ts";
delete pkg.scripts.prepare;

writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + "\n");
console.log("package.json rewritten for publish (restore it with `git restore package.json`).");
