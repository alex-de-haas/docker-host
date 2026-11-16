import { build, stop } from "esbuild";
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { repository, run } from "./local-runtime.mjs";

const require = createRequire(new URL("../package.json", import.meta.url));
const outputIndex = process.argv.indexOf("--output");
if (outputIndex !== -1 && !process.argv[outputIndex + 1]) throw new Error("Choose an API build output directory.");
const output = outputIndex === -1 ? repository : path.resolve(process.argv[outputIndex + 1]);
const result = await build({
  absWorkingDir: repository,
  entryPoints: { api: "apps/harness/src/main.ts" },
  outdir: output,
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
await writeFile(path.join(output, "runtime-sdk-imports.json"), JSON.stringify(sdkImports) + "\n");
// Release the bundler's worker before TypeScript checking in memory-limited Core setup
// containers. Keep the same static export and all Next type checks enabled.
stop();
if (!process.argv.includes("--api-only")) await run("npm", ["run", "build", "--workspace", "@haas/hosty-harness-web", "--", "--webpack"], repository,
  { boundedBuild: true });
