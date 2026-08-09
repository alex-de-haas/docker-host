import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isNodeEntry, resolveCodexCommand } from "./codex-binary.js";

// Codex offers two ways in, and the administrator picks:
//
//   * Interactive: the operator runs `codex login` on the host and the harness uses that session.
//     Simple, but a ChatGPT session expires — observed going offline mid-day.
//   * API key: set as an app setting. Codex ignores API keys in the environment, so the gateway
//     performs `codex login --with-api-key` on the operator's behalf, feeding the key over stdin.
//
// The API-key login writes credentials into a Codex home, which is why that mode gets its OWN home
// under the app's data directory: logging in there can never overwrite the operator's personal
// ~/.codex session. Choosing the key mode therefore does not cost the operator their own login.

export interface CodexAuthConfig {
  /** Operator-provided API key. Empty/undefined selects the interactive mode. */
  apiKey?: string;
  /** Explicit credential directory. Ignored in API-key mode, which owns its home. */
  codexHome?: string;
  /** App data directory; the API-key mode's home lives under it. */
  dataDir: string;
}

export type CodexAuthMode = "api-key" | "interactive";

export interface CodexAuthResolution {
  mode: CodexAuthMode;
  /** Env overrides for every spawned Codex process (empty when using the default home). */
  env: Record<string, string>;
  /** Set when the mode could not be established; surfaced as the health reason. */
  error?: string;
}

const FINGERPRINT_FILE = ".hosty-api-key-fingerprint";

export function authMode(config: CodexAuthConfig): CodexAuthMode {
  return config.apiKey?.trim() ? "api-key" : "interactive";
}

function apiKeyHome(config: CodexAuthConfig): string {
  return path.join(config.dataDir, "codex-home");
}

/**
 * Makes the selected mode usable, and returns the environment Codex processes must run with.
 * In API-key mode this performs the login when the stored fingerprint does not match the current
 * key, so rotating the key in app settings re-authenticates on the next probe or session.
 */
export async function ensureCodexAuth(config: CodexAuthConfig): Promise<CodexAuthResolution> {
  const key = config.apiKey?.trim();
  if (!key) {
    const home = config.codexHome?.trim();
    return { mode: "interactive", env: home ? { CODEX_HOME: home } : {} };
  }

  const home = apiKeyHome(config);
  const env = { CODEX_HOME: home };
  const fingerprint = createHash("sha256").update(key).digest("hex");
  const fingerprintPath = path.join(home, FINGERPRINT_FILE);

  const stored = await readFile(fingerprintPath, "utf8").catch(() => null);
  if (stored?.trim() === fingerprint) {
    return { mode: "api-key", env };
  }

  try {
    await mkdir(home, { recursive: true });
    await loginWithApiKey(key, env);
    // Only recorded after a successful login, so a failed attempt retries rather than sticking.
    await writeFile(fingerprintPath, fingerprint, { encoding: "utf8", mode: 0o600 });
    return { mode: "api-key", env };
  } catch (error) {
    return {
      mode: "api-key",
      env,
      error: `Signing Codex in with the configured API key failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

function loginWithApiKey(key: string, env: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const resolved = resolveCodexCommand();
    const args = ["login", "--with-api-key"];
    const child = isNodeEntry(resolved)
      ? spawn(process.execPath, [resolved, ...args], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } })
      : spawn(resolved, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });

    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(output.trim().slice(0, 200) || `exit ${code}`)),
    );

    // The key travels over stdin, never argv: process listings are world-readable on most hosts.
    child.stdin.end(`${key}\n`);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("timed out"));
    }, 20_000);
    child.on("exit", () => clearTimeout(timer));
  });
}
