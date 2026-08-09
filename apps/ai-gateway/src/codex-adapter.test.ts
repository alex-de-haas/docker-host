import { afterEach, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CodexHarnessAdapter } from "./harness/codex.js";
import { resolveHarnessKind } from "./config.js";
import type { HarnessEvent, HarnessRun } from "./harness/adapter.js";

// The adapter is exercised against test/fake-codex-server.mjs, which speaks the same dialect the
// live spike observed and exits non-zero on a protocol violation (wrong sandbox shape, or an
// approved_for_session reply). A regression in wire handling therefore fails here, not on a host.

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeServer = path.join(here, "..", "test", "fake-codex-server.mjs");
// Each run gets a throwaway data dir: the API-key mode writes its isolated Codex home under it.
const authDir = mkdtempSync(path.join(os.tmpdir(), "codex-auth-test-"));

async function waitFor<T>(probe: () => T | null | undefined | false, what: string): Promise<T> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("codex harness adapter", () => {
  let run: HarnessRun | null = null;
  let events: HarnessEvent[] = [];

  beforeEach(() => {
    events = [];
    // The adapter spawns `codex`; point it at the scripted stand-in. Node runs the .mjs directly
    // via its shebang, so the command is the script itself.
    process.env.HOSTY_AI_GATEWAY_CODEX_COMMAND = fakeServer;
  });

  afterEach(async () => {
    await run?.stop();
    run = null;
    delete process.env.HOSTY_AI_GATEWAY_CODEX_COMMAND;
  });

  function start(resumeHarnessSessionId?: string): HarnessRun {
    const adapter = new CodexHarnessAdapter({ dataDir: authDir });
    run = adapter.start({
      sessionId: "s1",
      cwd: process.cwd(),
      resumeHarnessSessionId,
      onEvent: (event) => events.push(event),
    });
    return run;
  }

  it("reports the harness session id from thread/start", async () => {
    start();
    const event = await waitFor(
      () => events.find((candidate) => candidate.type === "harness_session"),
      "harness_session",
    );
    expect(event).toMatchObject({ harnessSessionId: "thread-fake-1" });
  });

  it("resumes an existing thread instead of starting a new one", async () => {
    start("thread-from-before-restart");
    const event = await waitFor(
      () => events.find((candidate) => candidate.type === "harness_session"),
      "harness_session",
    );
    expect(event).toMatchObject({ harnessSessionId: "thread-from-before-restart" });
  });

  it("streams deltas and the final assistant text, then completes the turn", async () => {
    const active = start();
    await waitFor(() => events.find((candidate) => candidate.type === "harness_session"), "handshake");
    active.send("say hello");

    await waitFor(() => events.find((candidate) => candidate.type === "result"), "result");
    const deltas = events.filter((event) => event.type === "assistant_delta").map((event) => event.text);
    expect(deltas.join("")).toBe("hello");
    expect(events.some((event) => event.type === "assistant_text" && event.text === "hello")).toBe(true);
  });

  it("pauses on an approval request and executes only after allow", async () => {
    const active = start();
    await waitFor(() => events.find((candidate) => candidate.type === "harness_session"), "handshake");
    active.send("please write the file");

    const approval = await waitFor(
      () => events.find((candidate) => candidate.type === "approval_request"),
      "approval_request",
    );
    expect(approval).toMatchObject({ toolName: "FileChange" });
    // Nothing ran while the approval was pending.
    expect(events.some((event) => event.type === "tool_use")).toBe(false);

    expect(active.resolveApproval(approval.approvalId, "allow")).toBe(true);
    await waitFor(() => events.find((candidate) => candidate.type === "result"), "result after allow");
    expect(events.some((event) => event.type === "tool_use")).toBe(true);
    expect(events.some((event) => event.type === "assistant_text" && event.text === "written")).toBe(true);
  });

  it("denies without executing and reports an unknown approval id", async () => {
    const active = start();
    await waitFor(() => events.find((candidate) => candidate.type === "harness_session"), "handshake");
    active.send("write something");

    const approval = await waitFor(
      () => events.find((candidate) => candidate.type === "approval_request"),
      "approval_request",
    );
    expect(active.resolveApproval(approval.approvalId, "deny")).toBe(true);

    await waitFor(() => events.find((candidate) => candidate.type === "result"), "result after deny");
    expect(events.some((event) => event.type === "tool_use")).toBe(false);
    expect(events.some((event) => event.type === "assistant_text" && event.text === "skipped")).toBe(true);
    // A second decision on the same approval is not accepted.
    expect(active.resolveApproval(approval.approvalId, "allow")).toBe(false);
  });

  it("surfaces a harness error when the process dies mid-session", async () => {
    const active = start();
    await waitFor(() => events.find((candidate) => candidate.type === "harness_session"), "handshake");
    // Kill the scripted server the way a crashing harness would go away.
    (active as unknown as { child: { kill: (signal: string) => void } }).child.kill("SIGKILL");

    const error = await waitFor(() => events.find((candidate) => candidate.type === "error"), "error event");
    expect(error).toMatchObject({ type: "error" });
  });

  it("probes as unavailable with an actionable reason when the CLI is missing", async () => {
    process.env.HOSTY_AI_GATEWAY_CODEX_COMMAND = path.join(here, "..", "test", "definitely-not-installed");
    const availability = await new CodexHarnessAdapter({ dataDir: authDir }).probe();
    expect(availability.available).toBe(false);
    expect(availability.reason).toMatch(/could not be started/i);
  });
});

describe("harness selection", () => {
  it("maps the operator setting, defaulting unknown values to claude", () => {
    expect(resolveHarnessKind("codex")).toBe("codex");
    expect(resolveHarnessKind(" Codex ")).toBe("codex");
    expect(resolveHarnessKind("claude")).toBe("claude");
    expect(resolveHarnessKind("fake")).toBe("fake");
    expect(resolveHarnessKind(undefined)).toBe("claude");
    expect(resolveHarnessKind("gpt-9")).toBe("claude");
  });
});

describe("codex binary resolution", () => {
  afterEach(() => {
    delete process.env.HOSTY_AI_GATEWAY_CODEX_COMMAND;
  });

  it("prefers the operator override over the pinned dependency", async () => {
    const { resolveCodexCommand } = await import("./harness/codex-binary.js");
    process.env.HOSTY_AI_GATEWAY_CODEX_COMMAND = "/custom/codex";
    expect(resolveCodexCommand()).toBe("/custom/codex");
  });

  it("resolves the pinned @openai/codex entry when no override is set", async () => {
    const { resolveCodexCommand, isNodeEntry } = await import("./harness/codex-binary.js");
    const resolved = resolveCodexCommand();
    // The pin is what the adapter's protocol handling and tests were written against; falling back
    // to a PATH install is allowed, but on a workspace with the dependency installed it must win.
    expect(resolved).toContain("@openai/codex");
    expect(isNodeEntry(resolved)).toBe(true);
  });
});

describe("codex auth modes", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "codex-auth-mode-"));
    process.env.HOSTY_AI_GATEWAY_CODEX_COMMAND = fakeServer;
  });

  afterEach(() => {
    delete process.env.HOSTY_AI_GATEWAY_CODEX_COMMAND;
    rmSync(dir, { recursive: true, force: true });
  });

  it("signs Codex in with the configured API key, in a home of its own", async () => {
    const availability = await new CodexHarnessAdapter({ apiKey: "sk-test-key", dataDir: dir }).probe();
    expect(availability.available).toBe(true);
    // The login landed in the app's own Codex home, never the operator's ~/.codex.
    const authFile = path.join(dir, "codex-home", "auth.json");
    expect(JSON.parse(readFileSync(authFile, "utf8")).key).toBe("sk-test-key");
  });

  it("re-authenticates when the operator rotates the key", async () => {
    const config = { apiKey: "sk-first", dataDir: dir };
    await new CodexHarnessAdapter(config).probe();
    const authFile = path.join(dir, "codex-home", "auth.json");
    expect(JSON.parse(readFileSync(authFile, "utf8")).key).toBe("sk-first");

    await new CodexHarnessAdapter({ ...config, apiKey: "sk-second" }).probe();
    expect(JSON.parse(readFileSync(authFile, "utf8")).key).toBe("sk-second");
  });

  it("uses the operator's own login when no key is configured", async () => {
    const operatorHome = path.join(dir, "operator-codex");
    mkdirSync(operatorHome, { recursive: true });
    writeFileSync(path.join(operatorHome, "auth.json"), JSON.stringify({ chatgpt: true }));

    const availability = await new CodexHarnessAdapter({ codexHome: operatorHome, dataDir: dir }).probe();
    expect(availability.available).toBe(true);
    // No isolated home was created: the interactive mode leaves credential handling to the host.
    expect(existsSync(path.join(dir, "codex-home"))).toBe(false);
  });

  it("reports an actionable reason when neither mode is set up", async () => {
    const availability = await new CodexHarnessAdapter({ codexHome: path.join(dir, "empty"), dataDir: dir }).probe();
    expect(availability.available).toBe(false);
    expect(availability.reason).toMatch(/codex login|API key in this app's settings/i);
  });

  it("tells the operator to sign in with the configured Codex home", async () => {
    // A login run without this prefix writes credentials into the default home, which the harness
    // never reads — the operator would sign in and still see the assistant as unavailable.
    const home = path.join(dir, "custom-home");
    const availability = await new CodexHarnessAdapter({ codexHome: home, dataDir: dir }).probe();
    expect(availability.reason).toContain(`CODEX_HOME=${home} codex login`);
  });

  it("does not prefix the reason when the default Codex home is used", async () => {
    const availability = await new CodexHarnessAdapter({ dataDir: dir }).probe();
    expect(availability.reason).toContain("codex login");
    expect(availability.reason).not.toContain("CODEX_HOME=");
  });
});
