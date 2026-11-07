import { build } from "esbuild";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { repository, run } from "./local-runtime.mjs";

const require = createRequire(new URL("../package.json", import.meta.url));
const runtime = await build({
  absWorkingDir: repository,
  entryPoints: { api: "apps/harness/src/main.ts", worker: "apps/harness/src/worker/main.ts" },
  outdir: repository,
  outExtension: { ".js": ".mjs" },
  bundle: true, platform: "node", format: "esm", target: "node24", packages: "external",
  metafile: true,
  plugins: [{
    name: "compiled-hosty-sdk",
    setup(builder) {
      builder.onResolve({ filter: /^@hosty-sdk\/app(?:\/|$)/ }, args => ({ path: require.resolve(args.path) }));
    },
  }],
  logLevel: "info",
});
const imports = [...new Set(Object.values(runtime.metafile.outputs).flatMap(output =>
  output.imports.filter(value => value.external).map(value => value.path)))];
await writeFile(path.join(repository, "runtime-imports.json"), JSON.stringify(imports));
await run("npm", ["run", "build", "--workspace", "@haas/hosty-harness-web"], repository);
