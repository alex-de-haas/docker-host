import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ALL_JOBS, BASE_JOBS, COMPONENTS, PROFILES, classifyPaths, evaluateGate, fullPlan, planOutputs, versionOnlyBuildProps } from "./ci-policy.mjs";

const script = fileURLToPath(new URL("./ci-policy.mjs", import.meta.url));
const core = name => `apps/core/src/Haas.Hosty.Core/${name}`;
const cli = name => `apps/cli/src/Haas.Hosty.Cli/${name}`;
function results(plan) {
  return Object.fromEntries(ALL_JOBS.map(job => [job, { result: plan.required.includes(job) ? "success" : "skipped" }]));
}
function assertSelection(paths, components, profiles = [], extra = []) {
  const plan = classifyPaths(paths);
  assert.deepEqual(plan.components, COMPONENTS.filter(job => components.includes(job)));
  assert.deepEqual(plan.profiles, PROFILES.filter(job => profiles.includes(job)));
  assert.deepEqual(plan.required, ALL_JOBS.filter(job => [...BASE_JOBS, ...components, ...profiles, ...extra].includes(job)));
  for (const job of plan.required) assert.ok(plan.reasons[job]?.length, `missing reason for ${job}`);
  return plan;
}

test("documentation validates its actual Documents parser dependency without native workloads", () => {
  assertSelection(["docs/features/example/feature.md", "scripts/docs-index.test.mjs"], ["documents"]);
  assertSelection(["README.md", "AGENTS.md"], []);
});

test("web changes select their consumers and do not compile Core", () => {
  assertSelection(["apps/shell/src/app/page.tsx"], ["shell"]);
  assertSelection(["shared/web/workspace-activation.tsx"], ["shell", "harness"]);
  assertSelection(["apps/harness/web/src/components/chat.tsx"], ["harness"]);
});

test("ordinary Core production changes add AOT without every native scenario", () => {
  assertSelection([core("AppDirectoryEndpoints.cs")], ["core"], ["core-aot"]);
  assertSelection(["apps/core/tests/Haas.Hosty.Core.Tests/AppDirectoryTests.cs"], ["core"]);
  assertSelection([cli("Commands/UsersCommand.cs")], ["cli"]);
});

test("lifecycle, serializer and launch changes retain component and AOT checks", () => {
  assertSelection([core("WorkspaceActivationService.Return.cs")], ["core"], ["core-aot"]);
  assertSelection([core("CoreJsonSerializerContext.cs")], ["core"], ["core-aot"]);
  assertSelection([cli("Commands/CoreBuildService.cs")], ["cli"], []);
  assertSelection([core("LocalCommandRuntimeAdapter.cs")], ["core"], ["core-aot"]);
  assertSelection(["apps/cli/tests/Haas.Hosty.Cli.Tests/Commands/SharedReceiptSharingTests.cs"], ["cli"], []);
  assertSelection(["shared/CoreLaunchState.cs"], ["core", "cli"], ["core-aot"]);
});

test("local integration fixtures select their bounded component checks", () => {
  assertSelection([core("DockerCoreListener.cs")], ["core"], ["core-aot"]);
  assertSelection(["scripts/check-docker-core-transport.py"], ["core"], []);
  assertSelection(["scripts/check-core-aot.mjs"], ["core"], ["core-aot"]);
  assertSelection(["scripts/check-workspace-activation.py"], ["core", "cli"], []);
});

test("worker and speech inputs retain component tests without native acceptance", () => {
  assertSelection(["apps/harness/src/runtime/worker.ts"], ["harness"], []);
  assertSelection(["apps/harness/src/sessions/manager.ts"], ["harness"], []);
  assertSelection(["scripts/check-harness-worker.mjs"], ["harness"], []);
  assertSelection(["apps/harness/src/worker/engine.ts"], ["harness"], []);
  assertSelection(["apps/harness/test/worker-native-controls.mjs"], ["harness"], []);
  assertSelection(["apps/harness/worker/Dockerfile"], ["harness"], []);
  assertSelection(["apps/whisper/Hosty.Whisper/SpeechEngine.cs"], ["whisper"], []);
  assertSelection(["apps/whisper/Hosty.Whisper.Tests/Fixtures/russian.wav"], ["whisper"], []);
  assertSelection(["apps/whisper/Hosty.Whisper.Tests/WaveAudioTests.cs"], ["whisper"]);
});

test("Node dependency changes fan out only to Node consumers", () => {
  const node = ["shell", "app-sdk", "demo-app", "marketplace", "documents", "harness", "telemetry-ui"];
  assertSelection(["package-lock.json"], node);
  assertSelection(["packages/app-sdk/src/session.ts"], node);
  assertSelection([".npmrc"], node);
});

test(".NET toolchain changes retain every .NET component and NativeAOT build", () => {
  for (const path of ["global.json", "Directory.Build.props", "Directory.Build.targets", "scripts/HostyBuildIdentity.cs"]) {
    assertSelection([path], ["app-sdk-dotnet", "whisper", "core", "cli", "telemetry-backend"], ["core-aot"]);
  }
  assertSelection(["packages/app-sdk-dotnet/HostySdk.App/Session.cs"], ["app-sdk-dotnet", "whisper"], []);
});

test("workflow scheduling edits do not rebuild unrelated clients, artifact workflows retain their gate", () => {
  assertSelection([".github/workflows/ci.yml"], [], [], ["actionlint"]);
  assertSelection([".github/workflows/claude-code-review.yml"], [], [], ["actionlint"]);
  assert.deepEqual(classifyPaths([".github/workflows/new-qualification.yml"]).required, ALL_JOBS);
  assertSelection([".github/workflows/cardputer-release.yml"], ["cardputer-shell"], [], ["actionlint"]);
  assertSelection([".github/workflows/harness-worker-image.yml"], ["harness"], [], ["actionlint"]);
  assertSelection([".github/workflows/cli-release.yml"], ["core", "cli"], ["core-aot"], ["actionlint"]);
  assertSelection([".github/actions/publish-guard/guard.sh"], [], [], ["actionlint"]);
});

test("all first-party component roots and joint telemetry manifests have explicit ownership", () => {
  for (const [path, component] of [["marketplace", "marketplace"], ["documents", "documents"], ["telemetry-ui", "telemetry-ui"], ["demo-app", "demo-app"], ["shell-swift", "swift-shell"], ["shell-cardputer", "cardputer-shell"], ["telemetry-backend", "telemetry-backend"]]) {
    assertSelection([`apps/${path}/new-input`], [component]);
  }
  assertSelection(["apps/telemetry/manifest.json"], ["telemetry-backend", "telemetry-ui"]);
});

test("unknown, deleted, retired and invalid paths widen validation instead of being ignored", () => {
  for (const path of ["new-toolchain.cfg", "apps/unknown/deleted.cs", "apps/workspaces/deleted.ts", "shared/future/contracts.cs", "../apps/shell/file", "/absolute/file", ""]) {
    assert.deepEqual(classifyPaths([path]).required, ALL_JOBS, path);
  }
  assert.deepEqual(classifyPaths(["scripts/ci-policy.mjs"]).required, ALL_JOBS);
  assert.deepEqual(classifyPaths(["scripts/ci-select.test.mjs"]).required, ALL_JOBS);
  assert.deepEqual(fullPlan().required, ALL_JOBS);
  assert.throws(() => classifyPaths(null), /array of strings/);
  assert.throws(() => classifyPaths([null]), /array of strings/);
});

test("selection is deterministic and deduplicates changed names", () => {
  const paths = [core("WorkspaceActivationPlanner.cs"), "shared/web/workspace-activation.tsx", "README.md"];
  assert.deepEqual(classifyPaths([...paths].reverse().concat(paths)), classifyPaths(paths));
});

test("aggregate accepts successful required and intentionally skipped unaffected jobs", () => {
  const plan = classifyPaths(["apps/shell/src/app/page.tsx"]);
  assert.deepEqual(evaluateGate(plan, results(plan)), []);
  const onlyRequired = Object.fromEntries(plan.required.map(job => [job, { result: "success" }]));
  assert.deepEqual(evaluateGate(plan, onlyRequired), []);
  const build = { version: 1, components: [], profiles: ["core-aot"], required: [...BASE_JOBS, "core-aot"], reasons: {} };
  assert.deepEqual(evaluateGate(build, results(build)), []);
});

for (const result of ["failure", "cancelled", "skipped", "neutral", undefined]) {
  test(`aggregate rejects a required job with result ${result}`, () => {
    const plan = classifyPaths(["apps/shell/src/app/page.tsx"]);
    const needs = results(plan);
    needs.shell = { result };
    assert.ok(evaluateGate(plan, needs).some(error => error.includes("shell")));
  });
}

test("aggregate rejects missing required results and failed classification", () => {
  const plan = classifyPaths([]);
  const needs = results(plan);
  delete needs.docs;
  assert.ok(evaluateGate(plan, needs).some(error => error.includes("docs: missing")));
  needs.changes = { result: "failure" };
  assert.ok(evaluateGate(plan, needs).some(error => error.includes("changes")));
  assert.ok(evaluateGate(null, needs).some(error => error.includes("classification")));
  assert.ok(evaluateGate(plan, null).some(error => error.includes("job results")));
});

test("aggregate also rejects failed or cancelled jobs outside required selection", () => {
  const plan = classifyPaths([]);
  for (const result of ["failure", "cancelled"]) {
    const needs = results(plan);
    needs["core-aot"] = { result };
    assert.ok(evaluateGate(plan, needs).some(error => error.includes(`core-aot did not succeed: ${result}`)));
  }
});

test("aggregate rejects malformed or weakened classification contracts", () => {
  const plan = classifyPaths(["apps/shell/src/app/page.tsx"]);
  for (const invalid of [
    { ...plan, version: 2 }, { ...plan, reasons: null },
    { ...plan, required: plan.required.filter(job => job !== "ci-policy") },
    { ...plan, required: plan.required.filter(job => job !== "shell") },
    { ...plan, components: [] }, { ...plan, components: ["unrecognized-job"] },
    { ...plan, profiles: ["unrecognized-profile"] },
    { ...plan, required: [...plan.required, "shell"] },
  ]) assert.ok(evaluateGate(invalid, results(plan)).length, JSON.stringify(invalid));
});

test("output values have fixed keys and exclude hostile filenames", () => {
  const plan = classifyPaths(["docs/features/example/line\nforged_output=true.md"]);
  const outputs = planOutputs(plan);
  assert.equal(outputs.documents, "true");
  assert.equal(outputs.core_aot, "false");
  assert.equal(outputs.workflows, "false");
  assert.ok(!outputs.plan.includes("\n"));
  assert.deepEqual(JSON.parse(outputs.plan), { ...plan, reasons: {} });
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "hosty-ci-policy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  delete env.GITHUB_OUTPUT;
  function git(...args) {
    const result = spawnSync("git", args, { cwd: root, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git("init", "-b", "main");
  function commit() {
    git("add", "--all");
    git("-c", "user.name=CI Policy Fixture", "-c", "user.email=ci-fixture@example.test", "commit", "-m", "Test fixture");
    return git("rev-parse", "HEAD");
  }
  return { root, env, git, commit };
}

test("CLI uses actual Git deleted and renamed paths, and safely writes GitHub outputs", t => {
  const f = fixture(t);
  const beforePath = join(f.root, core("WorkspaceActivationService.cs"));
  mkdirSync(dirname(beforePath), { recursive: true });
  writeFileSync(beforePath, "source fixture\n");
  const base = f.commit();
  const afterPath = join(f.root, "docs", process.platform === "win32" ? "renamed.md" : "renamed\nforged_output=true.md");
  mkdirSync(dirname(afterPath), { recursive: true });
  renameSync(beforePath, afterPath);
  const head = f.commit();
  const output = join(f.root, "github-output");
  const run = spawnSync(process.execPath, [script, "classify", "--base", base, "--head", head], { cwd: f.root, env: { ...f.env, GITHUB_OUTPUT: output }, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const plan = JSON.parse(run.stdout);
  assert.ok(plan.components.includes("core"), "removed source must still select its original component");
  assert.ok(plan.components.includes("documents"), "rename destination must select its new consumer");
  assert.deepEqual(plan.profiles, ["core-aot"]);
  const lines = readFileSync(output, "utf8").trimEnd().split("\n");
  assert.equal(lines.length, Object.keys(planOutputs(plan)).length);
  assert.ok(!lines.some(line => line === "forged_output=true"));
  assert.deepEqual(JSON.parse(lines.find(line => line.startsWith("plan=")).slice(5)), { ...plan, reasons: {} });
});

test("CLI fails classification instead of producing a green empty plan for bad refs", t => {
  const f = fixture(t);
  for (const sha of ["HEAD", "--help", "a".repeat(40)]) {
    const run = spawnSync(process.execPath, [script, "classify", "--base", sha, "--head", "b".repeat(40)], { cwd: f.root, env: f.env, encoding: "utf8" });
    assert.equal(run.status, 1);
    assert.equal(run.stdout, "");
    assert.match(run.stderr, /full Git commit SHA|Git classification failed/);
  }
});

test("CLI gate consumes JSON from environment and returns a failing exit for denied admission", () => {
  const plan = classifyPaths(["apps/shell/src/app/page.tsx"]);
  const env = { ...process.env, CI_PLAN: JSON.stringify(plan), CI_NEEDS_JSON: JSON.stringify(results(plan)) };
  let run = spawnSync(process.execPath, [script, "gate"], { env, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const denied = results(plan);
  denied.shell.result = "skipped";
  run = spawnSync(process.execPath, [script, "gate"], { env: { ...env, CI_NEEDS_JSON: JSON.stringify(denied) }, encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Required job shell: skipped/);
  run = spawnSync(process.execPath, [script, "gate"], { env: { ...env, CI_PLAN: "not JSON" }, encoding: "utf8" });
  assert.equal(run.status, 1);
});


test("large change sets keep gate environment bounded without weakening required checks", () => {
  const paths = Array.from({ length: 750 }, (_, index) => core(`${"nested/".repeat(16)}file-${index}.cs`));
  const plan = classifyPaths(paths);
  assert.ok(Buffer.byteLength(JSON.stringify(plan)) > 128 * 1024, "fixture exceeds Linux's per-string exec limit");
  const outputs = planOutputs(plan);
  const needs = { ...results(plan), changes: { result: "success", outputs } };
  const env = { ...process.env, CI_PLAN: outputs.plan, CI_NEEDS_JSON: JSON.stringify(needs) };
  assert.ok(Buffer.byteLength(env.CI_PLAN) < 8 * 1024);
  assert.ok(Buffer.byteLength(env.CI_NEEDS_JSON) < 8 * 1024);
  const transported = JSON.parse(outputs.plan);
  for (const field of ["components", "profiles", "required"]) assert.deepEqual(transported[field], plan[field]);
  assert.equal(plan.reasons.core.length, paths.length, "full per-path diagnostics remain available");
  let run = spawnSync(process.execPath, [script, "gate"], { env, encoding: "utf8" });
  assert.equal(run.status, 0, run.error?.message || run.stderr);
  needs.core.result = "failure";
  run = spawnSync(process.execPath, [script, "gate"], { env: { ...env, CI_NEEDS_JSON: JSON.stringify(needs) }, encoding: "utf8" });
  assert.equal(run.status, 1, run.error?.message || run.stderr);
  assert.match(run.stderr, /Required job core: failure/);
});

test("platform version-only metadata does not trigger unrelated .NET runtimes", () => {
  const props = version => `<Project>\n<!-- Platform version -->\n<PropertyGroup><Version>${version}</Version></PropertyGroup>\n</Project>\n`;
  assert.equal(versionOnlyBuildProps(props("0.145.8"), props("0.145.9")), true);
  assert.equal(versionOnlyBuildProps(props("0.145.8"), props("0.145.8")), false);
  for (const after of [
    props("0.145.9").replace("</PropertyGroup>", "<Nullable>enable</Nullable></PropertyGroup>"),
    props("0.145.9").replace("<Project>", '<Project Sdk="Something">'),
    props("0.145.9").replace("</Project>", ""),
    props("0.145.9").replace("<!-- Platform version -->", "<!-- invalid -- comment -->"),
    props("invalid"), "", null,
  ]) assert.equal(versionOnlyBuildProps(props("0.145.8"), after), false, String(after));
  assert.equal(versionOnlyBuildProps(null, props("0.145.9")), false);
  const plan = classifyPaths(["Directory.Build.props"], { versionOnlyPaths: ["Directory.Build.props"] });
  assert.deepEqual(plan.components, ["core", "cli"]);
  assert.deepEqual(plan.profiles, ["core-aot"]);
  const lifecycle = classifyPaths(["Directory.Build.props", core("WindowsProcessControl.cs")], { versionOnlyPaths: ["Directory.Build.props"] });
  assert.deepEqual(lifecycle.profiles, ["core-aot"]);
  assert.throws(() => classifyPaths(["global.json"], { versionOnlyPaths: ["global.json"] }), /Only validated/);
});

test("CLI inspects actual props contents before applying the metadata exemption", t => {
  const f = fixture(t);
  const path = join(f.root, "Directory.Build.props");
  writeFileSync(path, "<Project><PropertyGroup><Version>0.1.0</Version></PropertyGroup></Project>\n");
  const base = f.commit();
  writeFileSync(path, "<Project><PropertyGroup><Version>0.1.1</Version></PropertyGroup></Project>\n");
  const versionHead = f.commit();
  function classify(head) {
    const run = spawnSync(process.execPath, [script, "classify", "--base", base, "--head", head], { cwd: f.root, env: f.env, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout);
  }
  assert.deepEqual(classify(versionHead).profiles, ["core-aot"]);
  writeFileSync(path, "<Project><PropertyGroup><Version>0.1.2</Version><Nullable>enable</Nullable></PropertyGroup></Project>\n");
  const config = classify(f.commit());
  assert.deepEqual(config.profiles, ["core-aot"]);
  assert.ok(config.components.includes("whisper"));
  assert.ok(config.components.includes("app-sdk-dotnet"));
});

test("runtime acceptance cannot be selected even for unknown or shared toolchain changes", () => {
  const retired = ["workspace-native-activation", "core-windows-process-control", "core-transport", "harness-worker", "whisper-native"];
  for (const paths of [["global.json"], ["unknown-input"], ["scripts/check-workspace-activation.py"]]) {
    const plan = classifyPaths(paths);
    for (const job of retired) {
      assert.ok(!plan.required.includes(job));
      assert.ok(!(job.replaceAll("-", "_") in planOutputs(plan)));
    }
  }
  for (const job of retired) {
    const plan = { ...classifyPaths([]), profiles: [job], required: [...BASE_JOBS, job] };
    assert.ok(evaluateGate(plan, results(plan)).some(error => error.includes("Unknown")));
  }
  assertSelection(["scripts/test-integration.mjs", "scripts/test-integration.test.mjs"], []);
});
