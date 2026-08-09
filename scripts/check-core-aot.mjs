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

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Known AOT hazards that predate this check. Each entry is a source file whose IL warnings are
// accepted for now; nothing else may warn. Shrinking this list is the goal — never grow it without
// deciding that the hazard is acceptable.
const ALLOWED_WARNING_FILES = [
  // JsonArray.Add<JsonObject> on the cloudflared ingress config: reflection-based JSON node writing,
  // outside the source-generated context every other Core payload uses.
  "CloudflareTunnelConfigPatcher.cs",
];

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
} finally {
  rmSync(output, { recursive: true, force: true });
}

function defaultRuntime() {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  if (process.platform === "darwin") return `osx-${arch}`;
  if (process.platform === "win32") return `win-${arch}`;
  return `linux-${arch}`;
}
