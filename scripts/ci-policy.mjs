#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const BASE_JOBS = Object.freeze(["changes", "versions", "docs", "ci-policy"]);
export const COMPONENTS = Object.freeze([
  "shell", "app-sdk", "app-sdk-dotnet", "whisper", "demo-app", "core", "cli",
  "telemetry-backend", "marketplace", "plans", "harness", "telemetry-ui", "swift-shell", "cardputer-shell",
]);
export const PROFILES = Object.freeze([
  "core-aot", "core-windows-process-control", "workspace-native-activation", "core-transport", "harness-worker", "whisper-native",
]);
export const ALL_JOBS = Object.freeze([...BASE_JOBS, "actionlint", ...COMPONENTS, ...PROFILES]);
const NODE_COMPONENTS = ["shell", "app-sdk", "demo-app", "marketplace", "plans", "harness", "telemetry-ui"];
const DOTNET_COMPONENTS = ["app-sdk-dotnet", "whisper", "core", "cli", "telemetry-backend"];
const CORE_PROFILES = ["core-aot", "core-windows-process-control", "workspace-native-activation", "core-transport"];
const COMPONENT_PATHS = [
  ["apps/shell/", "shell"], ["apps/demo-app/", "demo-app"], ["apps/marketplace/", "marketplace"],
  ["apps/plans/", "plans"], ["apps/harness/", "harness"], ["apps/telemetry-ui/", "telemetry-ui"],
  ["apps/shell-swift/", "swift-shell"], ["apps/shell-cardputer/", "cardputer-shell"],
];
const NATIVE_INPUT = /(?:WorkspaceActivation|WorkspaceRuntimeActivation|WorkspaceReturn|CoreDevelopment|CoreBuild|CoreCommand|CoreLaunch|CoreStateSnapshot|CoreLifecycle|DevelopmentWorkspace|MountPathPolicy|WorkspaceDirectoryIdentity|RuntimePreparation|LocalCommand|DetachedCli|ProcessLiveness|ProcessRunner|WindowsProcessControl|SharedReceiptSharing)/;
const WINDOWS_INPUT = /(?:WindowsProcessControl|LocalCommand|ProcessRunner|ProcessLiveness|CoreDevelopment|CoreLaunch|CoreStateSnapshot|MountPathPolicy|WorkspaceDirectoryIdentity|WorkspaceGit|SourceDocument|SharedReceiptSharing|DetachedCli)/;
const WORKER_INPUT = /^apps\/harness\/(?:worker\/|src\/worker\/|test\/worker-native|src\/runtime\/|src\/harness\/|src\/sessions\/(?:manager|docker-manager|shutdown|development|core-recovery|workspace)(?:\.|\/))/;
const BUILD_CONFIG = /(?:^|\/)(?:[^/]+\.csproj|global\.json|[Nn]u[Gg]et\.[Cc]onfig|appsettings[^/]*\.json)$/;
const WORKFLOW_COMPONENTS = {
  "shell-image.yml": ["shell"], "demo-app-image.yml": ["demo-app"], "marketplace-image.yml": ["marketplace"],
  "plans-image.yml": ["plans"], "telemetry-ui-image.yml": ["telemetry-ui"],
  "telemetry-backend-image.yml": ["telemetry-backend"], "publish-app-sdk.yml": ["app-sdk"],
  "publish-app-sdk-dotnet.yml": ["app-sdk-dotnet"], "cardputer-release.yml": ["cardputer-shell"],
  "cli-release.yml": ["core", "cli"], "harness-worker-image.yml": ["harness"],
};

/** Only the repository's version-only props schema is exempt; unfamiliar XML remains conservative. */
export function versionOnlyBuildProps(before, after) {
  function version(source) {
    if (typeof source !== "string") return null;
    // An XML comment cannot contain a double hyphen. Reject malformed comments instead of
    // accidentally treating invalid build configuration as a harmless version bump.
    const comments = source.match(/<!--[\s\S]*?-->/g) ?? [];
    if (comments.some(comment => comment.slice(4, -3).includes("--"))) return null;
    const xml = source.replace(/<!--[\s\S]*?-->/g, "");
    const match = /^\s*<Project>\s*<PropertyGroup>\s*<Version>((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?)<\/Version>\s*<\/PropertyGroup>\s*<\/Project>\s*$/.exec(xml);
    return match?.[1] ?? null;
  }
  const previous = version(before);
  const next = version(after);
  return previous !== null && next !== null && previous !== next;
}

/** Classifies names from Git, including names of files that no longer exist. */
export function classifyPaths(paths, { versionOnlyPaths = [] } = {}) {
  if (!Array.isArray(paths) || paths.some(path => typeof path !== "string")) {
    throw new TypeError("Changed paths must be an array of strings");
  }
  if (!Array.isArray(versionOnlyPaths) || versionOnlyPaths.some(path => path !== "Directory.Build.props")) throw new TypeError("Only validated Directory.Build.props metadata may be exempted");
  const selected = new Set(BASE_JOBS);
  const reasons = Object.fromEntries(BASE_JOBS.map(job => [job, ["Always required"]]));
  function add(jobs, reason) {
    for (const job of Array.isArray(jobs) ? jobs : [jobs]) {
      selected.add(job);
      const entries = reasons[job] ??= [];
      if (!entries.includes(reason)) entries.push(reason);
    }
  }
  function all(reason) { add(ALL_JOBS, reason); }
  for (const path of [...new Set(paths)].sort()) {
    const reason = rule => `${path}: ${rule}`;
    if (!path || path.startsWith("/") || path.includes("\0") || path.split("/").some(part => part === "." || part === "..")) {
      all(reason("unrecognized path; validate all jobs"));
    } else if (/^scripts\/ci[^/]*\.(?:mjs|js)$/.test(path)) {
      all(reason("CI selection or gate implementation"));
    } else if (path.startsWith(".github/workflows/")) {
      add("actionlint", reason("workflow syntax"));
      const name = path.slice(".github/workflows/".length);
      if (!(name in WORKFLOW_COMPONENTS) && !["ci.yml", "claude-code-review.yml"].includes(name)) all(reason("unrecognized workflow; validate all jobs"));
      add(WORKFLOW_COMPONENTS[name] ?? [], reason("artifact workflow"));
      if (name === "harness-worker-image.yml") add("harness-worker", reason("worker workflow"));
      if (name === "cli-release.yml") add("core-aot", reason("platform publication workflow"));
    } else if (path.startsWith(".github/actions/")) {
      add("actionlint", reason("composite action"));
    } else if (path.startsWith("docs/") || /^scripts\/docs-index(?:\.test)?\.mjs$/.test(path)) {
      add("plans", reason("canonical document parser contract"));
    } else if (["README.md", "AGENTS.md", "CLAUDE.md", "LICENSE", ".gitignore", ".gitattributes", ".editorconfig", ".github/dependabot.yml"].includes(path)) {
      // These repository metadata files do not change a compiled/runtime input.
    } else if (path === "package-lock.json" || [".npmrc", ".node-version", ".nvmrc"].includes(path)) {
      add(NODE_COMPONENTS, reason("shared Node dependencies or toolchain"));
    } else if (path === "package.json") {
      all(reason("root workspace and build/test commands"));
    } else if (path === "Directory.Build.props" && versionOnlyPaths.includes(path)) {
      add(["core", "cli", "core-aot"], reason("platform version metadata only"));
    } else if (["global.json", "Directory.Build.props", "Directory.Build.targets", "NuGet.Config", "nuget.config", "scripts/HostyBuildIdentity.cs"].includes(path)) {
      add(DOTNET_COMPONENTS, reason("shared .NET build input"));
      add([...CORE_PROFILES, "whisper-native"], reason("shared .NET runtime/toolchain input"));
    } else if (path.startsWith("packages/app-sdk/")) {
      add(NODE_COMPONENTS, reason("shared app SDK"));
    } else if (path.startsWith("packages/app-sdk-dotnet/")) {
      add(["app-sdk-dotnet", "whisper"], reason("shared .NET app SDK"));
      if (!path.includes(".Tests/")) add("whisper-native", reason("speech host SDK dependency"));
    } else if (path.startsWith("shared/web/")) {
      add(["shell", "harness"], reason("shared web components"));
    } else if (/^shared\/[^/]+\.cs$/.test(path)) {
      add(["core", "cli", ...CORE_PROFILES], reason("shared native launch and recovery contracts"));
    } else if (path.startsWith("apps/core/")) {
      add("core", reason("Core component"));
      if (path.startsWith("apps/core/src/") || BUILD_CONFIG.test(path)) add("core-aot", reason("Core production input"));
      if (NATIVE_INPUT.test(path) || BUILD_CONFIG.test(path) || /\/(?:Program|HostyCoreApplication|CoreJsonSerializerContext)\.cs$/.test(path)) {
        add("workspace-native-activation", reason("native preparation, handover or recovery"));
      }
      if (WINDOWS_INPUT.test(path) || BUILD_CONFIG.test(path) || /\/(?:Program|HostyCoreApplication)\.cs$/.test(path)) {
        add("core-windows-process-control", reason("Windows process, path or receipt behavior"));
      }
      if (/\/(?:DockerCoreListener|Program|HostyCoreApplication|RuntimeAppManifest)\.cs$/.test(path) || BUILD_CONFIG.test(path)) {
        add("core-transport", reason("Core listener or Docker transport contract"));
      }
    } else if (path.startsWith("apps/cli/")) {
      add("cli", reason("CLI component"));
      if (NATIVE_INPUT.test(path) || BUILD_CONFIG.test(path) || /\/Program\.cs$/.test(path)) {
        add("workspace-native-activation", reason("CLI native preparation, handover or recovery"));
      }
      if (WINDOWS_INPUT.test(path) || BUILD_CONFIG.test(path)) add("core-windows-process-control", reason("Windows process, path or receipt behavior"));
    } else if (path.startsWith("apps/whisper/")) {
      add("whisper", reason("Whisper component"));
      if (path.startsWith("apps/whisper/Hosty.Whisper/") || /\/(?:NativeSpeechTests\.cs|Fixtures\/)/.test(path) || BUILD_CONFIG.test(path) || path.endsWith("/manifest.json")) {
        add("whisper-native", reason("speech inference or native runtime input"));
      }
    } else if (path.startsWith("apps/telemetry-backend/")) {
      add("telemetry-backend", reason("telemetry backend"));
    } else if (path.startsWith("apps/telemetry/")) {
      add(["telemetry-backend", "telemetry-ui"], reason("shared telemetry application manifest/configuration"));
    } else if (COMPONENT_PATHS.some(([prefix]) => path.startsWith(prefix))) {
      const [, component] = COMPONENT_PATHS.find(([prefix]) => path.startsWith(prefix));
      add(component, reason("component source or configuration"));
      if (WORKER_INPUT.test(path) || /^apps\/harness\/(?:package(?:-lock)?\.json|manifest\.json)$/.test(path)) {
        add("harness-worker", reason("worker image, transport or session lifecycle"));
      }
    } else if (path === "scripts/check-workspace-activation.py") {
      add(["core", "cli", "workspace-native-activation", "core-windows-process-control"], reason("native acceptance fixture"));
    } else if (path === "scripts/check-core-aot.mjs") {
      add(["core", "core-aot"], reason("NativeAOT compatibility gate"));
    } else if (path === "scripts/check-docker-core-transport.py") {
      add(["core", "core-transport"], reason("Docker transport fixture"));
    } else if (path === "scripts/check-harness-worker.mjs") {
      add(["harness", "harness-worker"], reason("Docker worker fixture"));
    } else if (path === "scripts/check-versions.mjs") {
      add("cardputer-shell", reason("firmware version contract"));
    } else if (["scripts/install.sh", "scripts/install.ps1"].includes(path)) {
      add("cli", reason("CLI installer"));
    } else if (path === "distribution-apps.json" || path.startsWith("channels/")) {
      add(["core", "cli"], reason("platform distribution input"));
    } else {
      all(reason("unrecognized input; validate all jobs"));
    }
  }
  return {
    version: 1,
    components: COMPONENTS.filter(job => selected.has(job)),
    profiles: PROFILES.filter(job => selected.has(job)),
    required: ALL_JOBS.filter(job => selected.has(job)),
    reasons: Object.fromEntries(ALL_JOBS.filter(job => reasons[job]).map(job => [job, reasons[job]])),
  };
}

export function fullPlan() { return classifyPaths(["scripts/ci-policy.mjs"]); }

/** Returns errors rather than trusting GitHub's successful conclusion for skipped jobs. */
export function evaluateGate(plan, needs) {
  const errors = [];
  if (!plan || plan.version !== 1 || !Array.isArray(plan.components) || !Array.isArray(plan.profiles) || !Array.isArray(plan.required)
      || !plan.reasons || typeof plan.reasons !== "object" || Array.isArray(plan.reasons)) {
    errors.push("Missing or invalid CI classification plan");
  } else {
    for (const [field, allowed] of [["components", COMPONENTS], ["profiles", PROFILES], ["required", ALL_JOBS]]) {
      for (const job of plan[field]) if (!allowed.includes(job)) errors.push(`Unknown ${field} job: ${String(job)}`);
      if (new Set(plan[field]).size !== plan[field].length) errors.push(`Duplicate jobs in ${field}`);
    }
    for (const job of [...BASE_JOBS, ...plan.components, ...plan.profiles]) {
      if (!plan.required.includes(job)) errors.push(`Classification omitted required job: ${job}`);
    }
    for (const job of plan.required) {
      if (COMPONENTS.includes(job) && !plan.components.includes(job)) errors.push(`Required component is absent from selection: ${job}`);
      if (PROFILES.includes(job) && !plan.profiles.includes(job)) errors.push(`Required profile is absent from selection: ${job}`);
    }
  }
  if (!needs || typeof needs !== "object" || Array.isArray(needs)) {
    errors.push("Missing or invalid CI job results");
    return errors;
  }
  for (const [job, value] of Object.entries(needs)) {
    if (!value || !["success", "skipped"].includes(value.result)) errors.push(`Job ${job} did not succeed: ${value?.result ?? "missing result"}`);
  }
  if (plan && Array.isArray(plan.required)) {
    for (const job of plan.required) {
      if (needs[job]?.result !== "success") errors.push(`Required job ${job}: ${needs[job]?.result ?? "missing"}`);
    }
  }
  return errors;
}

/** Values are fixed keys and one-line JSON; changed filenames cannot inject GitHub outputs. */
export function planOutputs(plan) {
  const result = { plan: JSON.stringify(plan) };
  for (const job of ALL_JOBS) result[job.replaceAll("-", "_")] = String(plan.required.includes(job));
  result.workflows = result.actionlint;
  return result;
}

function classifyGit(base, head) {
  for (const [name, value] of [["base", base], ["head", head]]) {
    if (!/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(value ?? "")) throw new Error(`--${name} must be a full Git commit SHA`);
  }
  // Disabling rename detection retains both sides, including deleted source inputs.
  const diff = spawnSync("git", ["diff", "--name-only", "--no-renames", "-z", base, head, "--"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (diff.error) throw diff.error;
  if (diff.status !== 0) throw new Error(`Git classification failed: ${(diff.stderr || `exit ${diff.status}`).trim()}`);
  const paths = diff.stdout.split("\0").filter(Boolean);
  const versionOnlyPaths = [];
  if (paths.includes("Directory.Build.props")) {
    const contents = sha => spawnSync("git", ["show", `${sha}:Directory.Build.props`], { encoding: "utf8", maxBuffer: 1024 * 1024 });
    const before = contents(base);
    const after = contents(head);
    if (!before.error && !after.error && before.status === 0 && after.status === 0 && versionOnlyBuildProps(before.stdout, after.stdout)) versionOnlyPaths.push("Directory.Build.props");
  }
  return classifyPaths(paths, { versionOnlyPaths });
}

function main(args) {
  if (args[0] === "classify" && args.length === 5 && args[1] === "--base" && args[3] === "--head") {
    const plan = classifyGit(args[2], args[4]);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(planOutputs(plan)).map(([key, value]) => `${key}=${value}\n`).join(""));
    console.log(JSON.stringify(plan));
  } else if (args.length === 1 && args[0] === "gate") {
    const errors = evaluateGate(JSON.parse(process.env.CI_PLAN ?? "null"), JSON.parse(process.env.CI_NEEDS_JSON ?? "null"));
    if (errors.length) throw new Error(errors.join("\n"));
    console.log("All CI checks required by the change policy passed.");
  } else throw new Error("Usage: node scripts/ci-policy.mjs classify --base SHA --head SHA | gate");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
