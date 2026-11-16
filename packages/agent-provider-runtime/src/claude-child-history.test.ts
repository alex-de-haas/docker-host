import { afterEach, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { copyFile, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

type Message = { type: string; uuid: string; session_id: string; parent_tool_use_id: string | null; parent_agent_id: string | null;
  message: { id?: string; content: Array<Record<string, unknown>> } };
async function fixture(change?: (messages: Message[]) => void, effect = "") {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "hosty-claude-history-kernel-"))); directories.push(directory);
  const nativeHome = path.join(directory, "native"), executionHome = path.join(directory, "execution"), cwd = path.join(directory, "workspace");
  await mkdir(cwd); await mkdir(nativeHome); await mkdir(executionHome);
  const nativeSessionId = randomUUID(), agentId = "native-child", parentToolUseId = "parent-tool", toolUseId = "child-bash";
  const assistantUuid: string = randomUUID(), resultUuid = randomUUID(), input = { timeout: 45000, command: "node -e harmless_fixture" };
  const project = path.join(nativeHome, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  const subagents = path.join(project, nativeSessionId, "subagents"); await mkdir(subagents, { recursive: true });
  const executionProjects = path.join(executionHome, "projects"); await symlink(path.join(nativeHome, "projects"), executionProjects);
  const root = path.join(project, `${nativeSessionId}.jsonl`), transcript = path.join(subagents, `agent-${agentId}.jsonl`);
  const sidecar = transcript.replace(/\.jsonl$/, ".meta.json");
  // Deliberately invalid JSONL: the kernel must never parse these bytes itself.
  await writeFile(root, "not parsed root transcript"); await writeFile(transcript, "not parsed child transcript"); await writeFile(sidecar, "not parsed metadata");
  const messages: Message[] = [
    { type: "assistant", uuid: assistantUuid, session_id: nativeSessionId, parent_tool_use_id: parentToolUseId, parent_agent_id: null,
      message: { id: "msg_fixture", content: [{ type: "tool_use", id: toolUseId, name: "Bash", input: { command: input.command, timeout: input.timeout } }] } },
    { type: "user", uuid: resultUuid, session_id: nativeSessionId, parent_tool_use_id: parentToolUseId, parent_agent_id: null,
      message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content: "Actual SDK error content", is_error: true }] } },
  ]; change?.(messages);
  const sdk = path.join(directory, "node_modules", "@anthropic-ai", "claude-agent-sdk"); await mkdir(sdk, { recursive: true });
  await writeFile(path.join(sdk, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", type: "module", exports: "./index.mjs" }));
  const calls = path.join(directory, "calls.json");
  await writeFile(path.join(sdk, "index.mjs"), `import {writeFile,appendFile,rename,utimes,unlink,symlink} from 'node:fs/promises';
    export async function getSubagentMessages(session,agent,options) {
      await writeFile(${JSON.stringify(calls)},JSON.stringify({session,agent,options,env:process.env,cwd:process.cwd()}));
      ${effect}
      return ${JSON.stringify(messages)};
    }
    export function query(){throw Error('Query forbidden');}
    export function listSubagents(){throw Error('Discovery forbidden');}
  `);
  const helper = path.join(directory, "reader.mjs"); await copyFile(fileURLToPath(new URL("./claude-child-history.mjs", import.meta.url)), helper);
  const logicalRoot = path.join(executionProjects, cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${nativeSessionId}.jsonl`);
  const logicalTranscript = path.join(executionProjects, cwd.replace(/[^a-zA-Z0-9]/g, "-"), nativeSessionId, "subagents", `agent-${agentId}.jsonl`);
  const request = { version: 1, nativeHome, executionHome, cwd, nativeSessionId, children: [{ agentId, transcriptPath: logicalRoot, parentToolUseId,
    calls: [{ assistantUuid, assistantMessageId: "msg_fixture", toolUseId, input }] }] };
  async function execute(body: unknown = request, environment: Record<string, string | undefined> = {}) {
    const child = spawn(process.execPath, [helper], { cwd, env: { HOME: nativeHome, CLAUDE_CONFIG_DIR: nativeHome, ...environment }, stdio: ["pipe", "pipe", "pipe"] });
    const output: Buffer[] = [], errors: Buffer[] = [];
    child.stdout.on("data", chunk => output.push(chunk)); child.stderr.on("data", chunk => errors.push(chunk));
    child.stdin.end(typeof body === "string" ? body : JSON.stringify(body));
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    expect(Buffer.concat(errors).toString()).toBe("");
    const text = Buffer.concat(output).toString(); expect(Buffer.byteLength(text)).toBeLessThanOrEqual(128 * 1024);
    return { code, response: JSON.parse(text) as { nativeSessionId: string | null; matches: Array<Record<string, unknown>>; unavailable: unknown[]; error?: string } };
  }
  return { directory, nativeHome, executionHome, executionProjects, logicalRoot, logicalTranscript, cwd, subagents, root, transcript, sidecar, request, messages, calls, execute };
}

it("uses only the isolated SDK read API and returns an exact failed child invocation without exit inference", async () => {
  const f = await fixture(), before = await readFile(f.transcript), result = await f.execute();
  expect(result.code).toBe(0); expect(result.response).toEqual({ version: 1, nativeSessionId: f.request.nativeSessionId, unavailable: [], matches: [{
    agentId: "native-child", parentToolUseId: "parent-tool", assistantUuid: f.request.children[0]!.calls[0]!.assistantUuid,
    assistantMessageId: "msg_fixture", historyAssistantUuid: f.messages[0]!.uuid,
    toolUseId: "child-bash", resultUuid: f.messages[1]!.uuid,
    result: { type: "tool_result", tool_use_id: "child-bash", content: "Actual SDK error content", is_error: true },
  }] });
  expect(result.response.matches[0]).not.toHaveProperty("exitCode"); expect(result.response.matches[0]).not.toHaveProperty("status");
  expect(await readFile(f.transcript)).toEqual(before);
  const call = JSON.parse(await readFile(f.calls, "utf8"));
  expect(call).toMatchObject({ session: f.request.nativeSessionId, agent: "native-child", options: { dir: f.cwd, limit: 128, offset: 0 }, cwd: f.cwd });
  expect(call.env.HOME).toBe(f.nativeHome); expect(call.env.CLAUDE_CONFIG_DIR).toBe(f.nativeHome);
  expect(Object.keys(call.env)).toEqual(expect.arrayContaining(["HOME", "CLAUDE_CONFIG_DIR"]));
  expect(Object.keys(call.env).some(key => /TOKEN|SECRET|API_KEY/.test(key))).toBe(false);
});

it("joins a real producer-shaped derived live block UUID to the original persisted UUID through the exact API message ID", async () => {
  const f = await fixture(messages => { messages[0]!.message.content.unshift({ type: "text", text: "I will run the child command." }); });
  const persistedUuid = f.messages[0]!.uuid;
  // Pinned CLI Wh/l2s/vTt emits original.slice(0,24) + a 12-digit
  // hexadecimal content-block index. getSubagentMessages preserves original.
  const liveBlockUuid = `${persistedUuid.slice(0, 24)}000000000001`;
  f.request.children[0]!.calls[0]!.assistantUuid = liveBlockUuid;
  expect(liveBlockUuid).not.toBe(persistedUuid);
  const result = await f.execute();
  expect(result.response.matches).toHaveLength(1);
  expect(result.response.matches[0]).toMatchObject({ assistantUuid: liveBlockUuid, historyAssistantUuid: persistedUuid,
    assistantMessageId: "msg_fixture", toolUseId: "child-bash" });
});

it("accepts an exact captured child transcript path as well as the known root transcript", async () => {
  const f = await fixture(); f.request.children[0]!.transcriptPath = f.transcript;
  expect((await f.execute()).response.matches).toHaveLength(1);
});

it.each(["logical child", "physical root"])("maps only the exact owned projects link for a captured %s path", async kind => {
  const f = await fixture(); f.request.children[0]!.transcriptPath = kind === "logical child" ? f.logicalTranscript : f.root;
  expect((await f.execute()).response.matches).toHaveLength(1);
});

it.each(["missing link", "directory instead of link", "foreign link", "multi-hop link", "relative link", "execution home alias", "durable projects alias", "macOS path alias"])("rejects %s before invoking the SDK", async kind => {
  const f = await fixture(), durableProjects = path.join(f.nativeHome, "projects");
  if (["missing link", "directory instead of link", "foreign link", "multi-hop link", "relative link"].includes(kind)) {
    await rm(f.executionProjects);
    if (kind === "directory instead of link") await mkdir(f.executionProjects);
    if (kind === "foreign link") {
      const other = path.join(f.directory, "foreign-projects"); await mkdir(other); await symlink(other, f.executionProjects);
    }
    if (kind === "multi-hop link") {
      const hop = path.join(f.directory, "projects-hop"); await symlink(durableProjects, hop); await symlink(hop, f.executionProjects);
    }
    if (kind === "relative link") await symlink(path.relative(f.executionHome, durableProjects), f.executionProjects);
  }
  if (kind === "execution home alias" || kind === "macOS path alias") {
    let alias = kind === "macOS path alias" ? f.executionHome.replace(/^\/private(?=\/(?:var|tmp)\/)/, "") : f.executionHome;
    if (alias === f.executionHome) { alias = path.join(f.directory, "execution-alias"); await symlink(f.executionHome, alias); }
    f.request.executionHome = alias;
  }
  if (kind === "durable projects alias") {
    const other = path.join(f.directory, "physical-projects");
    await import("node:fs/promises").then(fs => fs.rename(durableProjects, other)); await symlink(other, durableProjects);
  }
  const result = await f.execute(); expect(result.response.matches).toEqual([]);
  expect(result.response.unavailable).toEqual([{ agentId: "native-child", reason: "file_guard_failed" }]);
  await expect(lstat(f.calls)).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects an equivalent captured path through an undeclared link instead of trusting its realpath", async () => {
  const f = await fixture(), alias = path.join(f.directory, "undeclared-execution"); await symlink(f.executionHome, alias);
  f.request.children[0]!.transcriptPath = path.join(alias, path.relative(f.executionHome, f.logicalRoot));
  const result = await f.execute(); expect(result.response.matches).toEqual([]);
  expect(result.response.unavailable).toEqual([{ agentId: "native-child", reason: "captured_path_mismatch" }]);
  await expect(lstat(f.calls)).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects replacement of the owned projects link during an SDK read even when its target stays exact", async () => {
  const f = await fixture(), modulePath = path.join(f.directory, "node_modules", "@anthropic-ai", "claude-agent-sdk", "index.mjs");
  const change = `await unlink(${JSON.stringify(f.executionProjects)});await symlink(${JSON.stringify(path.join(f.nativeHome, "projects"))},${JSON.stringify(f.executionProjects)});`;
  await writeFile(modulePath, (await readFile(modulePath, "utf8")).replace("return [", `${change} return [`));
  const result = await f.execute(); expect(result.response.matches).toEqual([]);
  expect(result.response.unavailable).toEqual([{ agentId: "native-child", reason: "read_set_changed" }]);
});

it("does not confuse unrelated string-content user messages with the exact observed tool pair", async () => {
  const f = await fixture(messages => { messages.unshift({ ...structuredClone(messages[1]!), uuid: randomUUID(),
    message: { content: "The original child task" as unknown as Array<Record<string, unknown>> } }); });
  expect((await f.execute()).response.matches).toHaveLength(1);
});

it.each([
  ["session", (m: Message[]) => { m[1]!.session_id = randomUUID(); }],
  ["parent", (m: Message[]) => { m[1]!.parent_tool_use_id = "foreign-parent"; }],
  ["missing parent", (m: Message[]) => { delete (m[1] as Partial<Message>).parent_tool_use_id; }],
  ["nested parent", (m: Message[]) => { m[1]!.parent_agent_id = "nested-native-parent"; }],
  ["missing depth", (m: Message[]) => { delete (m[1] as Partial<Message>).parent_agent_id; }],
  ["API message ID", (m: Message[]) => { m[0]!.message.id = "msg_foreign"; }],
  ["missing API message ID", (m: Message[]) => { delete m[0]!.message.id; }],
  ["raw ID", (m: Message[]) => { m[1]!.message.content[0]!.tool_use_id = "foreign-call"; }],
  ["input", (m: Message[]) => { m[0]!.message.content[0]!.input = { command: "different command" }; }],
  ["background", (m: Message[]) => { m[0]!.message.content[0]!.input = { command: "node -e harmless_fixture", timeout: 45000, run_in_background: true }; }],
  ["MCP", (m: Message[]) => { m[0]!.message.content[0]!.name = "mcp__remote__write"; }],
  ["successful result", (m: Message[]) => { m[1]!.message.content[0]!.is_error = false; }],
  ["string error flag", (m: Message[]) => { m[1]!.message.content[0]!.is_error = "true"; }],
  ["earlier result", (m: Message[]) => { m.reverse(); }],
  ["duplicate result", (m: Message[]) => { m.push({ ...structuredClone(m[1]!), uuid: randomUUID() }); }],
  ["duplicate tool", (m: Message[]) => { m.push({ ...structuredClone(m[0]!), uuid: randomUUID() }); }],
  ["duplicate UUID", (m: Message[]) => { m[1]!.uuid = m[0]!.uuid; }],
  ["no result", (m: Message[]) => { m.pop(); }],
  ["unsupported result array", (m: Message[]) => { m[1]!.message.content[0]!.content = [{ type: "text", text: "Actual SDK error" }]; }],
  ["oversized result", (m: Message[]) => { m[1]!.message.content[0]!.content = "x".repeat(32769); }],
] as const)("keeps %s history unproven", async (_name, change) => {
  const f = await fixture(change), result = await f.execute(); expect(result.response.matches).toEqual([]);
  const expected = ["session", "parent", "missing parent", "nested parent", "missing depth"].includes(_name) ? "history_lineage_mismatch"
    : ["API message ID", "missing API message ID", "MCP"].includes(_name) ? "assistant_message_mismatch"
    : ["input", "background"].includes(_name) ? "tool_input_mismatch"
    : ["duplicate result", "duplicate tool"].includes(_name) ? "tool_pair_ambiguous"
    : _name === "duplicate UUID" ? "unsupported_history" : "terminal_unavailable";
  expect(result.response.unavailable).toEqual([{ agentId: "native-child", reason: expected }]);
});

it.each(["missing sidecar", "missing transcript", "empty root", "oversize transcript", "oversize sidecar", "child symlink", "sidecar symlink", "child hardlink", "sidecar hardlink", "directory symlink", "nested directory", "too many entries", "wrong captured path", "wrong cwd"])("does not invoke the SDK for %s", async kind => {
  const f = await fixture();
  if (kind === "missing sidecar") await rm(f.sidecar);
  if (kind === "missing transcript") await rm(f.transcript);
  if (kind === "empty root") await writeFile(f.root, "");
  if (kind === "oversize transcript") await writeFile(f.transcript, Buffer.alloc(1024 * 1024 + 1));
  if (kind === "oversize sidecar") await writeFile(f.sidecar, Buffer.alloc(64 * 1024 + 1));
  if (kind === "child symlink" || kind === "sidecar symlink") {
    const target = kind === "child symlink" ? f.transcript : f.sidecar, other = path.join(f.directory, "outside");
    await writeFile(other, "linked"); await rm(target); await symlink(other, target);
  }
  if (kind === "child hardlink" || kind === "sidecar hardlink") await link(kind === "child hardlink" ? f.transcript : f.sidecar, path.join(f.directory, "shared-inode"));
  if (kind === "directory symlink") {
    const other = path.join(f.directory, "other-subagents"); await mkdir(other); await rm(f.subagents, { recursive: true }); await symlink(other, f.subagents);
  }
  if (kind === "nested directory") await mkdir(path.join(f.subagents, "ambiguous-child-tree"));
  if (kind === "too many entries") await Promise.all(Array.from({ length: 255 }, (_, index) => writeFile(path.join(f.subagents, `other-${index}`), "x")));
  if (kind === "wrong captured path") f.request.children[0]!.transcriptPath = path.join(f.directory, "foreign.jsonl");
  if (kind === "wrong cwd") f.request.cwd = f.directory;
  const result = await f.execute(); expect(result.response.matches).toEqual([]);
  const expected = ["nested directory", "too many entries", "child symlink", "sidecar symlink"].includes(kind) ? "unsupported_layout"
    : kind === "wrong captured path" ? "captured_path_mismatch" : kind === "wrong cwd" ? "cwd_mismatch" : "file_guard_failed";
  expect(result.response.unavailable).toEqual([{ agentId: "native-child", reason: expected }]);
  await expect(lstat(f.calls)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["transcript replacement", "sidecar replacement", "mtime drift"])("rejects %s during the SDK read even if bytes/size stay equal", async kind => {
  const f = await fixture(), file = kind === "sidecar replacement" ? f.sidecar : f.transcript;
  const modulePath = path.join(f.directory, "node_modules", "@anthropic-ai", "claude-agent-sdk", "index.mjs");
  const change = kind === "mtime drift" ? `await utimes(${JSON.stringify(file)},1,1);`
    : `await writeFile(${JSON.stringify(`${file}.replacement`)},${JSON.stringify(await readFile(file, "utf8"))});await rename(${JSON.stringify(`${file}.replacement`)},${JSON.stringify(file)});`;
  await writeFile(modulePath, (await readFile(modulePath, "utf8")).replace("return [", `${change} return [`));
  const result = await f.execute(); expect(result.response.matches).toEqual([]);
  expect(result.response.unavailable).toEqual([{ agentId: "native-child", reason: "read_set_changed" }]);
});

it.each(["transcript", "sidecar", "root"])("rejects %s growth during SDK observation", async target => {
  const f = await fixture();
  const file = target === "transcript" ? f.transcript : target === "sidecar" ? f.sidecar : f.root;
  const modulePath = path.join(f.directory, "node_modules", "@anthropic-ai", "claude-agent-sdk", "index.mjs");
  await writeFile(modulePath, (await readFile(modulePath, "utf8")).replace("return [", `await appendFile(${JSON.stringify(file)},'drift'); return [`));
  const result = await f.execute(); expect(result.response.matches).toEqual([]);
  expect(result.response.unavailable).toEqual([{ agentId: "native-child", reason: "read_set_changed" }]);
});

it("reports a fixed SDK failure code without exposing its error text, paths, command or output", async () => {
  const secret = "sdk-secret-value-should-not-escape";
  const f = await fixture(undefined, `throw new Error(${JSON.stringify(secret)});`), result = await f.execute();
  expect(result.response.unavailable).toEqual([{ agentId: "native-child", reason: "sdk_read_failed" }]);
  const diagnostic = JSON.stringify(result.response);
  for (const value of [secret, f.nativeHome, f.cwd, f.request.children[0]!.calls[0]!.input.command, "Actual SDK error content"])
    expect(diagnostic).not.toContain(value);
});

it("distinguishes an unavailable SDK from its filesystem and history guards", async () => {
  const f = await fixture(); await rm(path.join(f.directory, "node_modules", "@anthropic-ai", "claude-agent-sdk", "index.mjs"));
  const result = await f.execute(); expect(result.response.matches).toEqual([]);
  expect(result.response.unavailable).toEqual([{ agentId: "native-child", reason: "sdk_unavailable" }]);
  expect(JSON.stringify(result.response)).not.toContain(f.directory);
});

it("bounds aggregate output without truncating or fabricating any matched error result", async () => {
  const f = await fixture(messages => {
    messages[1]!.message.content[0]!.content = "x".repeat(32768);
    for (let index = 1; index < 5; index++) {
      messages[0]!.message.content.push({ ...structuredClone(messages[0]!.message.content[0]!), id: `child-bash-${index}` });
      messages[1]!.message.content.push({ ...structuredClone(messages[1]!.message.content[0]!), tool_use_id: `child-bash-${index}` });
    }
  });
  f.request.children[0]!.calls = Array.from({ length: 5 }, (_, index) => ({ ...structuredClone(f.request.children[0]!.calls[0]!), toolUseId: index ? `child-bash-${index}` : "child-bash" }));
  const result = await f.execute(); expect(result.response.matches.length).toBeGreaterThan(0); expect(result.response.matches.length).toBeLessThan(5);
  expect(result.response.unavailable).toContainEqual({ agentId: "native-child", reason: "output_limit" });
});

it.each(["invalid JSON", "oversize request", "missing execution home", "duplicate requested raw ID", "duplicate child", "too many children", "too many calls", "missing parent", "missing tool ID", "missing API ID", "empty API ID", "oversize API ID", "wrong native environment", "background requested"])("rejects %s before any SDK call", async kind => {
  const f = await fixture(); let body: unknown = f.request, env: Record<string, string> = {};
  if (kind === "invalid JSON") body = "{";
  if (kind === "oversize request") body = " ".repeat(256 * 1024 + 1);
  if (kind === "missing execution home") delete (f.request as Partial<typeof f.request>).executionHome;
  if (kind === "duplicate requested raw ID") f.request.children[0]!.calls.push(structuredClone(f.request.children[0]!.calls[0]!));
  if (kind === "duplicate child") f.request.children.push(structuredClone(f.request.children[0]!));
  if (kind === "too many children") f.request.children = Array.from({ length: 9 }, (_, index) => ({ ...structuredClone(f.request.children[0]!), agentId: `child-${index}` }));
  if (kind === "too many calls") f.request.children[0]!.calls = Array.from({ length: 17 }, (_, index) => ({ ...structuredClone(f.request.children[0]!.calls[0]!), toolUseId: `tool-${index}` }));
  if (kind === "missing parent") delete (f.request.children[0] as Partial<typeof f.request.children[0]>).parentToolUseId;
  if (kind === "missing tool ID") delete (f.request.children[0]!.calls[0] as Partial<typeof f.request.children[0]["calls"][0]>).toolUseId;
  if (kind === "missing API ID") delete (f.request.children[0]!.calls[0] as Partial<typeof f.request.children[0]["calls"][0]>).assistantMessageId;
  if (kind === "empty API ID") f.request.children[0]!.calls[0]!.assistantMessageId = "";
  if (kind === "oversize API ID") f.request.children[0]!.calls[0]!.assistantMessageId = "m".repeat(513);
  if (kind === "wrong native environment") env = { HOME: path.join(f.directory, "foreign-home") };
  if (kind === "background requested") Object.assign(f.request.children[0]!.calls[0]!.input, { run_in_background: true });
  const result = await f.execute(body, env); expect(result.response.matches).toEqual([]);
  if (kind === "wrong native environment") expect(result.response.unavailable).toEqual([{ agentId: "native-child", reason: "environment_mismatch" }]);
  else expect(result.response.error).toBe("invalid_request");
  expect(JSON.stringify(result.response)).not.toContain(f.directory);
  await expect(lstat(f.calls)).rejects.toMatchObject({ code: "ENOENT" });
});
