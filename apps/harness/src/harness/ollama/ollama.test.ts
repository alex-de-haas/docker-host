import { afterEach, expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { OllamaClient, ollamaUrl } from "./client.js";
import { OllamaHarnessAdapter } from "./index.js";
import { OllamaExecutor } from "./executor.js";
import { OllamaStore } from "./state.js";
import { AgentConnections } from "../../connections/registry.js";
import { profileConfig } from "../../profiles/store.js";
import { validateSelection } from "../../worker/models.js";
import type {
  HarnessEvent,
  HarnessRun,
  HarnessStartOptions,
} from "../adapter.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
  vi.restoreAllMocks();
});
async function directory() {
  const root = await mkdtemp(path.join(os.tmpdir(), "hosty-ollama-test-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
}
const model = "qwen-fixture:27b";
type Frame = Record<string, unknown>;
const answer = (content = "Done"): Frame => ({
  model,
  message: { role: "assistant", content },
  done: true,
  prompt_eval_count: 25,
  eval_count: 5,
});
const tool = (name: string, args: Record<string, unknown>): Frame => ({
  model,
  message: {
    role: "assistant",
    content: "",
    tool_calls: [{ function: { name, arguments: args } }],
  },
  done: true,
});
function fixture(
  replies: Frame[] | ((body: any, index: number) => Frame | Frame[]),
  options: {
    context?: number;
    tags?: unknown[];
    details?: (name: string) => unknown;
  } = {},
) {
  const chats: any[] = [];
  const request = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      const route = String(url).split("/api/")[1];
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (route === "version") return Response.json({ version: "fixture" });
      if (route === "tags")
        return Response.json({ models: options.tags ?? [{ name: model }] });
      if (route === "show")
        return Response.json(
          options.details?.(body.model) ?? {
            capabilities: ["completion", "tools"],
            model_info: { "qwen.context_length": options.context ?? 32768 },
            thinking: { values: [false, "low", "medium"], default: "medium" },
          },
        );
      if (route !== "chat") throw new Error("Unexpected route: " + route);
      chats.push(body);
      const reply =
        typeof replies === "function"
          ? replies(body, chats.length - 1)
          : replies[chats.length - 1];
      if (!reply) throw new Error("Unexpected extra model call");
      const encoded = new TextEncoder().encode(
        (Array.isArray(reply) ? reply : [reply])
          .map((f) => JSON.stringify(f) + "\n")
          .join(""),
      );
      return new Response(
        new ReadableStream({
          start(c) {
            for (let i = 0; i < encoded.length; i += 7)
              c.enqueue(encoded.slice(i, i + 7));
            c.close();
          },
        }),
      );
    },
  ) as unknown as typeof fetch;
  return {
    client: new OllamaClient("http://fixture:11434", request),
    chats,
    request,
  };
}
async function start(
  f: ReturnType<typeof fixture>,
  extra: Partial<HarnessStartOptions> = {},
  root?: string,
) {
  root ??= await directory();
  const events: HarnessEvent[] = [];
  const adapter = new OllamaHarnessAdapter({
    url: "http://fixture",
    directory: path.join(root, "state"),
    client: f.client,
  });
  const run = adapter.start({
    cwd: root,
    sessionId: "conversation",
    onEvent: (e) => events.push(e),
    ...extra,
  });
  cleanup.push(() => run.stopAndWait!());
  return { root, events, run };
}
const wait = async (
  events: HarnessEvent[],
  type: HarnessEvent["type"],
  count = 1,
) => {
  await vi.waitFor(
    () =>
      expect(
        events.filter((e) => e.type === type).length,
      ).toBeGreaterThanOrEqual(count),
    { timeout: 8000, interval: 10 },
  );
  return events.filter((e) => e.type === type).at(-1)!;
};
async function allow(
  run: HarnessRun,
  events: HarnessEvent[],
  decision: "allow" | "deny" = "allow",
) {
  const e = await wait(events, "approval_request");
  if (e.type !== "approval_request") throw new Error("Missing approval");
  expect(
    await run.resolveApproval(e.approvalId, decision, "operator decision"),
  ).toBe(true);
  expect(await run.resolveApproval(e.approvalId, decision)).toBe(false);
}

it("discovers exact model tags and thinking options, disables incompatible entries and validates URLs", async () => {
  expect(ollamaUrl(undefined)).toBe("http://127.0.0.1:11434");
  expect(ollamaUrl("", true)).toBe("http://host.docker.internal:11434");
  expect(ollamaUrl("http://127.0.0.1:11434", true)).toBe(
    "http://127.0.0.1:11434",
  );
  for (const url of [
    "file:///tmp",
    "http://user:password@host",
    "http://host/?key=a",
  ])
    expect(() => ollamaUrl(url)).toThrow();
  const f = fixture([], {
    tags: [
      { name: model },
      { name: "embed:latest" },
      { name: "remote:cloud", remote_host: "cloud" },
    ],
    details: (name) => ({
      capabilities:
        name === "embed:latest" ? ["embedding"] : ["completion", "tools"],
      thinking: { values: [false, "medium"], default: "medium" },
    }),
  });
  const catalog = await f.client.models();
  expect(catalog.defaultModel).toBe(model);
  expect(catalog.models.find((m) => m.id === model)?.efforts).toEqual([
    { id: "false", label: "Off" },
    { id: "medium", label: "medium" },
  ]);
  expect(catalog.models.filter((m) => m.unavailableReason)).toHaveLength(2);
  expect(() =>
    validateSelection(
      { model: "embed:latest", reasoningEffort: null },
      catalog,
    ),
  ).toThrow();
  expect(
    profileConfig({
      name: "Local",
      description: "",
      instructions: "",
      connectionId: null,
      model,
      reasoningEffort: "false",
      skillIds: [],
    }),
  ).toMatchObject({ model });
});

it("streams Unicode text and retains context across turns and durable resume", async () => {
  const f = fixture([answer("Привет 👋"), answer("Second"), answer("Resumed")]);
  const s = await start(f, { reasoningEffort: "false" });
  s.run.send("First");
  await wait(s.events, "result");
  s.run.send("Second question");
  await wait(s.events, "result", 2);
  expect(f.chats[1].messages.some((m: any) => m.content === "Привет 👋")).toBe(
    true,
  );
  expect(f.chats[0].think).toBe(false);
  const session = s.events.find((e) => e.type === "harness_session")!;
  if (session.type !== "harness_session") throw new Error("Missing session");
  await s.run.stopAndWait!();
  const resumed = await start(
    f,
    { resumeHarnessSessionId: session.harnessSessionId },
    s.root,
  );
  resumed.run.send("Continue");
  await wait(resumed.events, "result");
  expect(
    f.chats[2].messages.some((m: any) => m.content === "Second question"),
  ).toBe(true);
  expect(
    s.events
      .filter((e) => e.type === "assistant_delta")
      .map((e) => e.text)
      .join(""),
  ).toBe("Привет 👋Second");
});

it("never dispatches a tool from an incomplete generation", async () => {
  const partial = tool("apply_patch", {
    path: "bad.txt",
    old_text: "",
    new_text: "bad",
  });
  delete partial.done;
  const f = fixture([partial]),
    s = await start(f, { autonomy: "autonomous" });
  s.run.send("Work");
  await wait(s.events, "error");
  expect(s.events.some((e) => e.type === "tool_use")).toBe(false);
  await expect(readFile(path.join(s.root, "bad.txt"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("binds patch approval to the observed file and rejects changed content", async () => {
  const f = fixture([
    tool("apply_patch", {
      path: "file.txt",
      old_text: "before",
      new_text: "after",
    }),
    answer(),
  ]);
  const s = await start(f);
  await writeFile(path.join(s.root, "file.txt"), "before");
  s.run.send("Change file");
  await wait(s.events, "approval_request");
  await writeFile(path.join(s.root, "file.txt"), "operator edit");
  await allow(s.run, s.events);
  await wait(s.events, "result");
  expect(await readFile(path.join(s.root, "file.txt"), "utf8")).toBe(
    "operator edit",
  );
  expect(s.events.find((e) => e.type === "tool_result")).toMatchObject({
    status: "failed",
  });
});

it("applies an approved patch, waits for an answer, and reports a failed command as failed", async () => {
  const f = fixture([
    tool("apply_patch", {
      path: "file.txt",
      old_text: "",
      new_text: "created",
    }),
    tool("ask_user", { question: "Which check?", options: ["Quick", "Full"] }),
    tool("run_command", { command: "exit 7" }),
    answer("The check failed."),
  ]);
  const s = await start(f);
  s.run.send("Create and check");
  await allow(s.run, s.events);
  const question = await wait(s.events, "question_request");
  if (question.type !== "question_request") throw new Error("Missing question");
  expect(
    s.run.resolveQuestion(question.questionId, { "Which check?": "Quick" }),
  ).toBe(true);
  const request = await wait(s.events, "approval_request", 2);
  if (request.type === "approval_request")
    await s.run.resolveApproval(request.approvalId, "allow");
  await wait(s.events, "result");
  expect(await readFile(path.join(s.root, "file.txt"), "utf8")).toBe("created");
  expect(s.events.find((e) => e.type === "command_result")).toMatchObject({
    exitCode: 7,
    status: "failed",
  });
  expect(f.chats[3].messages.at(-1).content).toContain('"status":"failed"');
});

it("denial never writes a file", async () => {
  const f = fixture([
    tool("apply_patch", { path: "denied.txt", old_text: "", new_text: "no" }),
    answer(),
  ]);
  const s = await start(f);
  s.run.send("Try");
  await allow(s.run, s.events, "deny");
  await wait(s.events, "result");
  await expect(readFile(path.join(s.root, "denied.txt"))).rejects.toMatchObject(
    { code: "ENOENT" },
  );
  expect(f.chats[1].messages.at(-1).content).toContain('"status":"denied"');
});

it("stops a command's background descendants before completing its tool call", async () => {
  const root = await directory(),
    executor = new OllamaExecutor(root);
  cleanup.push(() => executor.close());
  const command = "sleep 120 & echo $! > child.pid";
  const result = await executor.execute(
    "run_command",
    { command },
    new AbortController().signal,
  );
  expect(result.ok).toBe(true);
  const pid = Number(await readFile(path.join(root, "child.pid"), "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
});

it("cancels a running command and closes its execution claim", async () => {
  const f = fixture([
    tool("run_command", { command: "echo $$ > shell.pid; sleep 120" }),
  ]);
  const s = await start(f, { autonomy: "autonomous" });
  s.run.send("Wait");
  await vi.waitFor(
    async () =>
      expect(
        Number(await readFile(path.join(s.root, "shell.pid"), "utf8")),
      ).toBeGreaterThan(0),
    { timeout: 8000 },
  );
  const pid = Number(await readFile(path.join(s.root, "shell.pid"), "utf8"));
  await s.run.stopAndWait!();
  expect(() => process.kill(pid, 0)).toThrow();
  expect(f.chats).toHaveLength(1);
});

it("keeps dedicated file operations inside the selected workspace", async () => {
  const root = await directory(),
    outside = await directory();
  await writeFile(path.join(outside, "secret.txt"), "outside");
  await symlink(outside, path.join(root, "escape"));
  const executor = new OllamaExecutor(root);
  cleanup.push(() => executor.close());
  expect(
    (await executor.execute("list_directory", {}, new AbortController().signal))
      .ok,
  ).toBe(true);
  expect(
    await executor.execute(
      "read_file",
      { path: "escape/secret.txt" },
      new AbortController().signal,
    ),
  ).toMatchObject({ ok: false, error: expect.stringContaining("outside") });
});

it("loads nested instructions before proposing a mutation again", async () => {
  const args = { path: "nested/file.txt", old_text: "", new_text: "created" };
  const f = fixture([
    tool("apply_patch", args),
    tool("apply_patch", args),
    answer(),
  ]);
  const s = await start(f, { autonomy: "autonomous" });
  await mkdir(path.join(s.root, "nested"));
  await writeFile(
    path.join(s.root, "nested/AGENTS.md"),
    "Use the nested convention.",
  );
  s.run.send("Create file");
  await wait(s.events, "result");
  expect(f.chats[1].messages[0].content).toContain(
    "Use the nested convention.",
  );
  expect(f.chats[1].messages.at(-1).content).toContain(
    "propose the action again",
  );
  expect(await readFile(path.join(s.root, "nested/file.txt"), "utf8")).toBe(
    "created",
  );
});

it("requires explicit reconciliation after an unknown effect and never replays the saved call", async () => {
  const root = await directory(),
    id = randomUUID(),
    store = new OllamaStore(path.join(root, "state"), id);
  await store.save({
    version: 1,
    id,
    conversation: "conversation",
    resource: JSON.stringify({ cwd: root }),
    summary: "",
    messages: [
      { role: "user", content: "Create file" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            function: {
              name: "apply_patch",
              arguments: {
                path: "unknown.txt",
                old_text: "",
                new_text: "no replay",
              },
            },
          },
        ],
      },
    ],
    effects: [
      {
        id: "effect",
        name: "apply_patch",
        arguments: { path: "unknown.txt" },
        status: "running",
      },
    ],
  });
  const f = fixture([answer()]),
    s = await start(
      f,
      { resumeHarnessSessionId: id, autonomy: "autonomous" },
      root,
    );
  s.run.send("Continue");
  await wait(s.events, "approval_request");
  expect(f.chats).toHaveLength(0);
  await allow(s.run, s.events);
  await wait(s.events, "result");
  expect(s.events.filter((e) => e.type === "tool_use")).toHaveLength(0);
  await expect(readFile(path.join(root, "unknown.txt"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("preserves old history completely during bounded compaction", async () => {
  const fragments: string[] = [];
  const f = fixture(
    (body, index) => {
      if (body.messages[0].content.startsWith("Summarize conversation data")) {
        fragments.push(JSON.parse(body.messages[1].content).fragment);
        return answer("Retained objective and results.");
      }
      return answer(index === 0 ? "OLD_TAIL" : "Finished");
    },
    { context: 8192 },
  );
  const s = await start(f);
  s.run.send("A".repeat(6000));
  await wait(s.events, "result");
  s.run.send("B".repeat(3500));
  await wait(s.events, "result", 2);
  expect(fragments.join("")).toContain("OLD_TAIL");
  expect(JSON.parse(fragments.join("")).messages[0].content).toBe(
    "A".repeat(6000),
  );
  expect(s.events.some((e) => e.type === "notice")).toBe(true);
});

it("stores endpoint revisions without credentials and cannot rebind a reserved connection", async () => {
  const root = await directory(),
    secrets = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    };
  const registry = new AgentConnections(
    root,
    path.join(root, "cache"),
    secrets,
    "docker",
  );
  cleanup.push(() => registry.shutdown());
  const connection = await registry.update({
    name: "Ollama",
    kind: "ollama",
    auth: "none",
  });
  expect((await registry.list()).ollamaDefaultUrl).toBe(
    "http://host.docker.internal:11434",
  );
  const binding = (await registry.binding(connection.id))!,
    release = await registry.reserve(binding);
  await expect(
    registry.update({ baseUrl: "http://another:11434" }, connection.id),
  ).rejects.toMatchObject({ code: "provider_in_use" });
  release();
  const changed = await registry.update(
    { baseUrl: "http://another:11434" },
    connection.id,
  );
  expect(changed.revision).toBe(2);
  await expect(registry.adapter(binding)).rejects.toMatchObject({
    code: "provider_credentials_changed",
  });
  await registry.remove(connection.id);
  expect(secrets.get).not.toHaveBeenCalled();
  expect(secrets.set).not.toHaveBeenCalled();
  expect(secrets.delete).not.toHaveBeenCalled();
});

it("discovers authorized MCP tools, correlates results and reconnects on a later turn", async () => {
  const calls: string[] = [];
  const remote = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer scoped-test",
    );
    if (body.method.startsWith("notifications/"))
      return new Response(null, { status: 202 });
    calls.push(body.method);
    const result =
      body.method === "initialize"
        ? {
            protocolVersion: "2025-03-26",
            serverInfo: { name: "test", version: "1" },
            capabilities: { tools: {} },
          }
        : body.method === "tools/list"
          ? {
              tools: [
                {
                  name: "lookup",
                  description: "Read scoped fixture",
                  inputSchema: {
                    type: "object",
                    properties: { key: { type: "string" } },
                    required: ["key"],
                    additionalProperties: false,
                  },
                },
              ],
            }
          : {
              content: [
                { type: "text", text: "Observed " + body.params.arguments.key },
              ],
            };
    return Response.json({ jsonrpc: "2.0", id: body.id, result });
  });
  vi.stubGlobal("fetch", remote);
  cleanup.push(async () => {
    vi.unstubAllGlobals();
  });
  const f = fixture((body, index) => {
    if (index % 3 === 2) return answer();
    if (index % 3 === 0) return tool("discover_tools", { query: "lookup" });
    const exposed = body.tools.find((t: any) =>
      t.function.name.startsWith("mcp_"),
    );
    return tool(exposed.function.name, { key: "allowed" });
  });
  const s = await start(f, {
    mcpServers: {
      fixture: {
        url: "http://scoped.invalid/mcp",
        headers: { authorization: "Bearer scoped-test" },
      },
    },
    isAutoAllowed: (name) => name === "mcp__fixture__lookup",
  });
  s.run.send("Lookup");
  await wait(s.events, "result");
  s.run.send("Again");
  await wait(s.events, "result", 2);
  expect(calls.filter((m) => m === "tools/call")).toHaveLength(2);
  expect(calls.filter((m) => m === "initialize")).toHaveLength(2);
  expect(s.events.some((e) => e.type === "approval_request")).toBe(false);
  const uses = s.events.filter(
    (e): e is Extract<HarnessEvent, { type: "tool_use" }> =>
      e.type === "tool_use" && e.toolName.startsWith("mcp__"),
  );
  expect(uses[0]).toMatchObject({
    toolName: "mcp__fixture__lookup",
    mcp: { server: "fixture", tool: "lookup" },
  });
  expect(
    s.events.find(
      (e) => e.type === "tool_result" && e.toolUseId === uses[0]!.toolUseId,
    ),
  ).toMatchObject({
    toolUseId: uses[0]!.toolUseId,
    status: "completed",
    output: "Observed allowed",
  });
});

it("rejects a saved session under another resource without contacting the model", async () => {
  const f = fixture([answer()]),
    s = await start(f);
  s.run.send("First");
  await wait(s.events, "result");
  await s.run.stopAndWait!();
  const native = s.events.find((e) => e.type === "harness_session")!;
  if (native.type !== "harness_session") throw new Error("Missing session");
  const resumed = await start(
    f,
    {
      resumeHarnessSessionId: native.harnessSessionId,
      resource: { kind: "conversation", id: "different" },
    },
    s.root,
  );
  resumed.run.send("Continue");
  await wait(resumed.events, "error");
  expect(f.chats).toHaveLength(1);
});

it("does not substitute another model after the selected model disappears", async () => {
  const f = fixture([answer()]),
    s = await start(f);
  s.run.send("First");
  await wait(s.events, "result");
  await s.run.stopAndWait!();
  const native = s.events.find((e) => e.type === "harness_session")!;
  if (native.type !== "harness_session") throw new Error("Missing session");
  const other = fixture([answer()], { tags: [{ name: "other:latest" }] });
  const resumed = await start(
    other,
    { resumeHarnessSessionId: native.harnessSessionId },
    s.root,
  );
  resumed.run.send("Continue");
  await wait(resumed.events, "error");
  expect(other.chats).toHaveLength(0);
});

it("retains cleanup ownership after a termination failure and retries it explicitly", async () => {
  if (process.platform === "win32") return;
  const root = await directory(),
    executor = new OllamaExecutor(root);
  cleanup.push(() => executor.close());
  const original = process.kill;
  const deny = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid < 0)
      throw Object.assign(new Error("termination denied"), { code: "EPERM" });
    return original(pid, signal);
  });
  try {
    await expect(
      executor.execute("list_directory", {}, new AbortController().signal),
    ).rejects.toThrow("termination denied");
    await expect(executor.close()).rejects.toThrow("termination denied");
  } finally {
    deny.mockRestore();
    await executor.close();
  }
});

it("rejects a duplicate session writer while a decision is pending", async () => {
  const f = fixture([
      tool("apply_patch", { path: "one.txt", old_text: "", new_text: "one" }),
    ]),
    s = await start(f);
  s.run.send("Write");
  await wait(s.events, "approval_request");
  const native = s.events.find((e) => e.type === "harness_session")!;
  if (native.type !== "harness_session") throw new Error("Missing session");
  const duplicate = await start(
    f,
    { resumeHarnessSessionId: native.harnessSessionId },
    s.root,
  );
  duplicate.run.send("Duplicate");
  await wait(duplicate.events, "error");
  expect(f.chats).toHaveLength(1);
  await s.run.stopAndWait!();
});

it("revokes a pending MCP dispatch when configuration changes", async () => {
  const { OllamaMcp } = await import("./tools.js");
  const called = vi.fn();
  vi.spyOn(OllamaMcp.prototype, "load").mockImplementation(async function (
    this: InstanceType<typeof OllamaMcp>,
  ) {
    this.tools.push({
      type: "function",
      function: {
        name: "mcp_fixture",
        description: "fixture action",
        parameters: { type: "object" },
      },
    });
    this.bindings.set("mcp_fixture", {
      displayName: "mcp__fixture__action",
      name: "action",
      server: "fixture",
      validate: () => true,
      client: { callTool: called } as any,
    });
  });
  const f = fixture([tool("mcp_fixture", {}), answer()]),
    s = await start(f);
  s.run.send("Request");
  await wait(s.events, "approval_request");
  await s.run.setMcpServers!({});
  await allow(s.run, s.events);
  await wait(s.events, "result");
  expect(called).not.toHaveBeenCalled();
  expect(f.chats[1].messages.at(-1).content).toContain("configuration changed");
});

it("rejects invalid tool arguments and bounds the model loop", async () => {
  const f = fixture(() =>
    tool("apply_patch", {
      path: "must-not-exist.txt",
      old_text: 4,
      new_text: "no",
    }),
  );
  const s = await start(f, { autonomy: "autonomous" });
  s.run.send("Invalid actions");
  const event = await wait(s.events, "error");
  expect(event).toMatchObject({
    message: expect.stringContaining("model-step budget"),
  });
  expect(f.chats).toHaveLength(32);
  await expect(
    readFile(path.join(s.root, "must-not-exist.txt")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it("loads only exported skills and keeps references inside their selected package", async () => {
  const { OllamaContext } = await import("./context.js");
  const root = await directory(),
    executor = new OllamaExecutor(root);
  cleanup.push(() => executor.close());
  await mkdir(path.join(root, ".agents/skills/selected"), { recursive: true });
  await writeFile(
    path.join(root, ".agents/skills/selected/SKILL.md"),
    "---\ndescription: Selected fixture\n---\nSelected instructions",
  );
  await writeFile(path.join(root, "outside.md"), "not a skill");
  const context = new OllamaContext(executor, root, root);
  await context.initialize(new AbortController().signal);
  expect(context.text()).toContain("selected: Selected fixture");
  expect(await context.readSkill("selected")).toContain(
    "Selected instructions",
  );
  await expect(context.readSkill("unselected")).rejects.toThrow();
  await expect(
    context.readSkill("selected", "../../../outside.md"),
  ).rejects.toThrow("selected package");
});

it("retains a command's final Unicode output and actual failure", async () => {
  const root = await directory(),
    executor = new OllamaExecutor(root);
  cleanup.push(() => executor.close());
  const result = await executor.execute(
    "run_command",
    {
      command:
        "node -e \"process.stdout.write('Привет 👋');process.exitCode=9\"",
    },
    new AbortController().signal,
  );
  expect(result).toMatchObject({
    ok: true,
    result: { exitCode: 9, output: "Привет 👋", truncated: false },
  });
});

it("snapshots bounded UTF-8 attachments without exposing host paths", async () => {
  const { ollamaAttachments } = await import("./attachments.js");
  const root = await directory(),
    file = path.join(root, "notes.txt");
  await writeFile(file, "User text 👋");
  expect(
    await ollamaAttachments([{ name: "notes.txt", path: file }]),
  ).toContain("User text 👋");
  expect(
    await ollamaAttachments([{ name: "notes.txt", path: file }]),
  ).not.toContain(root);
  await expect(
    ollamaAttachments([{ name: "image.png", path: file }]),
  ).rejects.toThrow("images");
  await writeFile(file, Buffer.from([255]));
  await expect(
    ollamaAttachments([{ name: "notes.txt", path: file }]),
  ).rejects.toThrow("UTF-8");
  await writeFile(file, "x".repeat(32001));
  await expect(
    ollamaAttachments([{ name: "notes.txt", path: file }]),
  ).rejects.toThrow("32,000");
});

it("resumes the same worktree after its Git revision changes", async () => {
  const f = fixture([answer(), answer()]),
    s = await start(f, {
      resource: { kind: "worktree", id: "owned", revision: "before" },
    });
  s.run.send("First");
  await wait(s.events, "result");
  await s.run.stopAndWait!();
  const native = s.events.find((e) => e.type === "harness_session")!;
  if (native.type !== "harness_session") throw Error("Missing native session");
  const resumed = await start(
    f,
    {
      resource: { kind: "worktree", id: "owned", revision: "after" },
      resumeHarnessSessionId: native.harnessSessionId,
    },
    s.root,
  );
  resumed.run.send("Continue");
  await wait(resumed.events, "result");
  expect(f.chats).toHaveLength(2);
  const wrong = await start(
    f,
    {
      resource: { kind: "worktree", id: "unrelated", revision: "after" },
      resumeHarnessSessionId: native.harnessSessionId,
    },
    s.root,
  );
  await resumed.run.stopAndWait!();
  wrong.run.send("Wrong resource");
  await wait(wrong.events, "error");
  expect(f.chats).toHaveLength(2);
});
it("enters the first authorized worktree on the next turn with fresh instructions", async () => {
  const f = fixture([answer(), answer()]),
    s = await start(f, {
      resource: { kind: "conversation", id: "conversation" },
    });
  s.run.send("Prepare source");
  await wait(s.events, "result");
  await s.run.stopAndWait!();
  const native = s.events.find((e) => e.type === "harness_session")!;
  if (native.type !== "harness_session") throw Error("Missing native session");
  const tree = await directory();
  await writeFile(path.join(tree, "AGENTS.md"), "Worktree-specific rule");
  const resumed = await start(
    f,
    {
      cwd: tree,
      resource: { kind: "worktree", id: "authorized", revision: "head" },
      resumeHarnessSessionId: native.harnessSessionId,
    },
    s.root,
  );
  resumed.run.send("Continue in source");
  await wait(resumed.events, "result");
  expect(f.chats[1].messages[0].content).toContain("Worktree-specific rule");
  expect(
    f.chats[1].messages.some((m: any) =>
      m.content.includes("Earlier relative file paths"),
    ),
  ).toBe(true);
  expect(resumed.events.some((e) => e.type === "notice")).toBe(true);
});
