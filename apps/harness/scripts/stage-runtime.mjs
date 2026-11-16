import path from "node:path";
import { repository, stageRuntime } from "./local-runtime.mjs";

const output = process.argv[2];
if (!output || !path.isAbsolute(output) || path.resolve(output) === repository)
  throw new Error("Choose an absolute standalone runtime output directory distinct from the source root.");
await stageRuntime(repository, output);
console.log("Staged Harness compiled API, static UI and locked runtime dependencies.");
