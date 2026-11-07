import { build } from "esbuild";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { repository, run } from "./local-runtime.mjs";

const require = createRequire(new URL("../package.json", import.meta.url));
const result = await build({
  absWorkingDir: repository,
  entryPoints: { api: "apps/harness/src/main.ts", worker: "apps/harness/src/worker/main.ts" },
  outdir: repository,
  outExtension: { ".js": ".mjs" },
  bundle: true, platform: "node", format: "esm", target: "node24", packages: "external", metafile: true,
  plugins: [{
    name: "compiled-hosty-sdk",
    setup(builder) {
      builder.onResolve({ filter: /^@hosty-sdk\/app(?:\/|$)/ }, args => ({ path: require.resolve(args.path) }));
    },
  }],
  logLevel: "info",
});
// Backend entry points compile only the SDK slices they use. Retain external SDK imports,
// including scoped subpaths, without projecting its unrelated browser UI dependencies.
const sdk = JSON.parse(await readFile(path.join(repository, "packages/app-sdk/package.json"), "utf8"));
const sdkDependencies = Object.keys(sdk.dependencies ?? {});
const sdkImports = [...new Set(Object.values(result.metafile.outputs).flatMap(output => output.imports)
  .filter(item => item.external && sdkDependencies.some(name => item.path === name || item.path.startsWith(name + "/")))
  .map(item => item.path))].sort();
if (sdkImports.length > 256 || sdkImports.some(value => value.length > 2048))
  throw new Error("Compiled SDK runtime import inventory exceeds its bound.");
await writeFile(path.join(repository, "runtime-sdk-imports.json"), JSON.stringify(sdkImports) + "\n");
await run("npm", ["run", "build", "--workspace", "@haas/hosty-harness-web"], repository);
