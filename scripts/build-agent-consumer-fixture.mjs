import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw new Error("Supply the isolated fixture's absolute bundle output path.");
const result = await build({ absWorkingDir: root, entryPoints: [path.join(root, "scripts/fixtures/agent-consumer/main.mts")], outfile: output,
  platform: "node", target: "node24", format: "esm", bundle: true, metafile: true,
  alias: { "@hosty-sdk/app/agent/client": path.join(root, "packages/app-sdk/src/agent-client.ts"),
    "@hosty-sdk/app/agent": path.join(root, "packages/app-sdk/src/agent.ts"),
    "@hosty-sdk/app/app-code": path.join(root, "packages/app-sdk/src/app-code.ts") } });
for (const input of Object.keys(result.metafile.inputs))
  if (!input.startsWith("scripts/fixtures/agent-consumer/") && !input.startsWith("packages/app-sdk/src/"))
    throw new Error("The independent fixture imported a non-SDK implementation: " + input);
for (const generated of Object.values(result.metafile.outputs))
  if (generated.imports.some(input => !input.external || !input.path.startsWith("node:")))
    throw new Error("The independent consumer bundle has a non-builtin runtime dependency.");
