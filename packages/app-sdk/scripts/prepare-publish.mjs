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

const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
pkg.exports = Object.fromEntries(
  Object.entries(pkg.exports).map(([subpath, source]) => {
    const stem = source.replace(/^\.\/src\//, "").replace(/\.(tsx|ts)$/, "");
    return [subpath, { types: `./dist/${stem}.d.ts`, default: `./dist/${stem}.js` }];
  }),
);
pkg.types = "./dist/index.d.ts";
delete pkg.scripts.prepare;

writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + "\n");
console.log("package.json rewritten for publish (restore it with `git restore package.json`).");
