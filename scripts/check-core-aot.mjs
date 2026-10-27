#!/usr/bin/env node
// Publishes Core as a Native AOT binary and fails on any new trim/AOT warning.
//
// Core is Native AOT, but until now its `dotnet publish` only ran in the release workflow — so a
// change that broke trimming could sit on main until a release surfaced it. That gap stopped being
// theoretical when Core took its first NuGet dependency (ModelContextProtocol.AspNetCore): a package
// that is AOT-clean today can stop being so on any version bump, and the failure mode is a native
// binary that builds fine and then throws at runtime on a trimmed-away type.
//
// Warnings are checked against an allowlist of files rather than a count, so a pre-existing hazard
// does not mask a new one and adding an exception stays a deliberate, reviewed edit.
//
// The Release intermediates are cleared before publishing. Analyzer warnings are emitted by
// compilation, so on a warm tree MSBuild skips the compile, prints nothing, and the scan below passes
// while looking at a log with no warnings in it — a gate that is silently ineffective rather than
// merely wrong. That was observed, not guessed: with the allowlist emptied, a warm run still reported
// success. CI is always cold, so only a local run would have been fooled — which is precisely the run
// a developer would trust before pushing.

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

// Source files whose IL warnings are tolerated. Empty, and meant to stay that way: Core publishes with
// no trim/AOT warnings at all, so any entry here is a hazard someone decided to live with. Adding one
// needs that decision made explicitly, with the reason written next to it.
const ALLOWED_WARNING_FILES = [];

const PROJECT = "apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj";
const PROJECT_DIR = "apps/core/src/Haas.Hosty.Core";

const runtime = process.argv[2] ?? defaultRuntime();
const output = mkdtempSync(join(tmpdir(), "hosty-core-aot-"));

// Drop the Release intermediates so the compile actually re-runs. `obj/project.assets.json` lives at
// the obj root and is left alone, so this costs a recompile but not a restore.
for (const dir of ["obj/Release", "bin/Release"]) {
  rmSync(join(PROJECT_DIR, dir), { recursive: true, force: true });
}

try {
  const result = spawnSync(
    "dotnet",
    [
      "publish",
      PROJECT,
      "--configuration",
      "Release",
      "--runtime",
      runtime,
      "--self-contained",
      "true",
      "--output",
      output,
      "--nologo",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );

  const log = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  process.stdout.write(log);

  if (result.status !== 0) {
    console.error(`\nNative AOT publish failed for ${runtime}.`);
    process.exit(1);
  }

  // Both spellings appear in publish output: the analyzer's "warning IL2026:" and the ILC linker's
  // "Trim analysis warning IL2026:" / "AOT analysis warning IL3050:".
  const offenders = [
    ...new Set(
      log
        .split("\n")
        .filter((line) => /\bIL[23]\d{3}\b/.test(line))
        .map((line) => line.trim())
        .filter((line) => !ALLOWED_WARNING_FILES.some((file) => line.includes(file))),
    ),
  ];

  if (offenders.length > 0) {
    console.error(
      `\nNew trim/AOT warnings in Core's Native AOT publish (fix them, or add the file to ALLOWED_WARNING_FILES in ${import.meta.url.split("/").pop()} with a reason):\n` +
        offenders.join("\n"),
    );
    process.exit(1);
  }

  console.log(`\nCore published Native AOT for ${runtime} with no new trim/AOT warnings.`);
  await smoke(output);
} finally {
  rmSync(output, { recursive: true, force: true });
}

function defaultRuntime() {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  if (process.platform === "darwin") return `osx-${arch}`;
  if (process.platform === "win32") return `win-${arch}`;
  return `linux-${arch}`;
}

async function smoke(outputDirectory) {
  const executable = join(outputDirectory, process.platform === "win32" ? "hosty-core.exe" : "hosty-core");
  const dataRoot = join(outputDirectory, "smoke-data");
  mkdirSync(join(dataRoot, "core"), { recursive: true });
  const distribution = join(dataRoot, "core", "distribution-apps.json");
  writeFileSync(distribution, JSON.stringify({ schemaVersion: "distribution-apps.0.1", apps: [] }));
  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  // Inherit OS/runtime discovery only, never the operator's Hosty configuration or credentials.
  const allowed = /^(PATH|HOME|TMPDIR|TMP|TEMP|DOTNET_ROOT|LANG|SystemRoot|COMSPEC|USERPROFILE|LOCALAPPDATA|APPDATA|ProgramFiles(?:\(x86\))?|ProgramW6432|CommonProgramFiles(?:\(x86\))?|CommonProgramW6432|ProgramData|SystemDrive|windir|HOMEDRIVE|HOMEPATH|ALLUSERSPROFILE)$/i;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.test(key)));
  Object.assign(env, { HOSTY_DATA_ROOT: dataRoot, HOSTY_CORE_URL: origin,
    HOSTY_CORE_PORT: String(port), HOSTY_DISTRIBUTION_APPS_PATH: distribution });
  const started = performance.now();
  const child = spawn(executable, [], { cwd: outputDirectory, env, stdio: ["ignore", "pipe", "pipe"] });
  let tail = "";
  let spawnError;
  const capture = data => { tail = (tail + data.toString()).slice(-12000); };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  child.on("error", error => { spawnError = error; });
  const exited = new Promise(resolve => child.once("close", resolve));
  try {
    let ready = false;
    for (let attempt = 0; attempt < 150; attempt++) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`Native Core exited: ${tail}`);
      try {
        const response = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(1000) });
        ready = response.ok && (await response.json()).status === "ok";
      } catch { /* Listen readiness is asynchronous. */ }
      if (ready) break;
      await delay(200);
    }
    if (!ready) throw new Error(`Native Core did not become ready: ${tail}`);
    // Exercise routing, ASP.NET instrumentation, authorization and the new trace route in the
    // trimmed binary. The full managed observability suite checks authorized capture and storage.
    const denied = await fetch(`${origin}/api/internal/telemetry/traces`, { signal: AbortSignal.timeout(5000) });
    if (denied.status !== 401) throw new Error(`Trace pull without credentials returned ${denied.status}`);
    console.log(`Native AOT smoke passed: ready in ${Math.round(performance.now() - started)} ms; executable ${statSync(executable).size} bytes.`);
  } finally {
    if (child.exitCode === null && !spawnError) child.kill("SIGTERM");
    const stopped = await Promise.race([exited.then(() => true), delay(10000).then(() => false)]);
    if (!stopped) { child.kill("SIGKILL"); await exited; }
  }
}
