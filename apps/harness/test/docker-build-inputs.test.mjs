import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { repository } from "../scripts/local-runtime.mjs";

async function dockerStages() {
  const source = await readFile(path.join(repository, "apps/harness/Dockerfile"), "utf8"), stages = new Map();
  let stage;
  for (const line of source.split("\n")) {
    if (/^FROM /i.test(line)) { stage = / AS (\S+)$/i.exec(line)?.[1] ?? "runtime"; stages.set(stage, []); }
    else stages.get(stage)?.push(line);
  }
  return stages;
}
function copiedInputs(lines) {
  return lines.filter(line => line.startsWith("COPY ") && !line.includes("--from="))
    .flatMap(line => line.split(/\s+/).slice(1, -1));
}

it("keeps the web layer's real backend dependency closure while excluding API-only sources", async () => {
  const web = path.join(repository, "apps/harness/web"), configuration = ts.readConfigFile(path.join(web, "tsconfig.json"), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(configuration.config, ts.sys, web);
  const queue = parsed.fileNames.filter(file => !/\.(?:test|spec)\.[^.]+$/.test(file)), seen = new Set(), backend = new Set();
  while (queue.length) {
    const file = queue.shift(); if (seen.has(file)) continue; seen.add(file);
    const source = await readFile(file, "utf8");
    for (const reference of ts.preProcessFile(source, true, true).importedFiles) {
      const resolved = ts.resolveModuleName(reference.fileName, file, parsed.options, ts.sys).resolvedModule?.resolvedFileName;
      if (!resolved || resolved.includes("/node_modules/")) continue;
      if (resolved.startsWith(path.join(repository, "apps/harness/src/"))) backend.add(path.relative(repository, resolved));
      if (resolved.startsWith(path.join(repository, "apps/harness/"))) queue.push(resolved);
    }
  }
  const stages = await dockerStages(), webInputs = copiedInputs(stages.get("web"));
  expect(backend.size).toBeGreaterThan(0);
  for (const file of backend) expect(webInputs.some(input => input === file || file.startsWith(input + "/")), `Missing web build dependency: ${file}`).toBe(true);
  for (const file of ["apps/harness/src/main.ts", "apps/harness/src/sessions/manager.ts", "apps/harness/src/agent-providers/execution.ts"])
    expect(webInputs.some(input => input === file || file.startsWith(input + "/")), `API-only edit invalidates web layer: ${file}`).toBe(false);
  expect(stages.get("web").some(line => line.includes("ignoreBuildErrors"))).toBe(false);
});

it("launches the production image from only staged runtime assets and keeps development artifacts outside its context", async () => {
  const stages = await dockerStages(), final = stages.get("runtime").join("\n"), dependencies = stages.get("runtime-dependencies").join("\n");
  expect(final).toContain('CMD ["node", "api.mjs"]'); expect(final).toContain("HOSTY_HARNESS_WEB_OUTPUT=/app/web");
  expect(final).not.toMatch(/COPY .*\/(?:src|packages|shared)|--import|\btsx\b|--from=dependencies/);
  expect(dependencies).toContain("npm ci --omit=dev --ignore-scripts");
  const ignored = await readFile(path.join(repository, ".dockerignore"), "utf8");
  for (const item of ["apps/harness/**/*.test.*", "apps/harness/test", "apps/harness/web/out-build"]) expect(ignored.split("\n")).toContain(item);
});
