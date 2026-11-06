import { build } from "esbuild";
import { createRequire } from "node:module";
import { repository, run } from "./local-runtime.mjs";

const require = createRequire(new URL("../package.json", import.meta.url));
await build({
  absWorkingDir: repository,
  entryPoints: { api: "apps/harness/src/main.ts", worker: "apps/harness/src/worker/main.ts" },
  outdir: repository,
  outExtension: { ".js": ".mjs" },
  bundle: true, platform: "node", format: "esm", target: "node24", packages: "external",
  plugins: [{
    name: "compiled-hosty-sdk",
    setup(builder) {
      builder.onResolve({ filter: /^@hosty-sdk\/app(?:\/|$)/ }, args => ({ path: require.resolve(args.path) }));
    },
  }],
  logLevel: "info",
});
await run("npm", ["run", "build", "--workspace", "@haas/hosty-harness-web"], repository);
