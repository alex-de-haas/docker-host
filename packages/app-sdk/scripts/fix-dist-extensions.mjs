// tsc does not rewrite import specifiers, so the extensionless relative imports the source
// uses (the only form every source consumer — Turbopack, vitest, app typechecks — accepts)
// would break plain-Node ESM resolution in the emitted output. Append `.js` to relative
// specifiers in dist so the published files resolve everywhere, declarations included.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const distDir = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const specifier = /(from\s+")(\.\.?\/[^"]+?)(")/g;

for (const name of readdirSync(distDir)) {
  if (!/\.(js|d\.ts)$/.test(name)) continue;
  const path = join(distDir, name);
  const source = readFileSync(path, "utf8");
  const rewritten = source.replace(specifier, (match, head, spec, tail) =>
    /\.(js|json)$/.test(spec) ? match : `${head}${spec}.js${tail}`,
  );
  if (rewritten !== source) {
    writeFileSync(path, rewritten);
    console.log(`rewrote relative specifiers in dist/${name}`);
  }
}
