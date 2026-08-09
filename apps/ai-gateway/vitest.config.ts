import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // The suites configure the harness through process.env (the Codex binary override, the
    // delegated-token public key, the app id) and clean up after themselves. Run test files one at
    // a time so one file's afterEach cannot delete a variable another file is mid-test relying on —
    // observed once as a spurious failure that then took seven green runs to not reproduce.
    fileParallelism: false,
  },
});
