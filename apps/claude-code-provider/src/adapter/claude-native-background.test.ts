import { expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);

it("runs the pinned native SDK queued-parent and nested-command regressions with predictions enabled and disabled", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "hosty-claude-native-runner-"));
  const env: NodeJS.ProcessEnv = { HOME: home, CLAUDE_CONFIG_DIR: home, HOSTY_TEST_PROVIDER_INSTALLED_CLI: "1" };
  for (const key of ["PATH", "SystemRoot", "WINDIR", "PATHEXT", "TMPDIR", "TMP", "TEMP"])
    if (process.env[key] !== undefined) env[key] = process.env[key];
  try {
    const { stdout, stderr } = await execute(process.execPath,
      ["--import", "tsx", "--test", "--test-reporter=tap", "--test-name-pattern=queued-|nested-", "test/native-background.mjs"],
      { cwd: fileURLToPath(new URL("../../", import.meta.url)), env, timeout: 750_000, maxBuffer: 2 * 1024 * 1024 });
    const output = `${stdout}\n${stderr}`;
    // A green process with missing native binaries or silently skipped cases is not coverage.
    expect(output).toMatch(/^# pass 8$/m);
    expect(output).toMatch(/^# fail 0$/m);
    expect(output).toMatch(/^# skipped 0$/m);
    for (const outcome of ["queued-disabled", "queued-enabled", "queued-cancel-disabled", "queued-cancel-enabled",
      "nested-disabled", "nested-enabled", "nested-cancel-disabled", "nested-cancel-enabled"])
      expect(output).toMatch(new RegExp(`^ok \\d+ - installed Claude SDK background lifecycle: ${outcome} against local inference fixture$`, "m"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 780_000);
