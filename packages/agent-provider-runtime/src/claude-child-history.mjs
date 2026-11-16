import { lstat, opendir, readlink, realpath } from "node:fs/promises";
import path from "node:path";

// This process has no query/model API. Its owner supplies an isolated native
// HOME and a hard deadline, and awaits process/pipe closure before SDK sealing.
const REQUEST_BYTES = 256 * 1024, OUTPUT_BYTES = 128 * 1024;
const TRANSCRIPT_BYTES = 1024 * 1024, SIDECAR_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9_-]{1,256}$/;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const identifier = value => typeof value === "string" && ID.test(value);
class ReaderFailure extends Error {
  constructor(code) { super(code); this.code = code; }
}
const requireValue = (value, code = "invalid_request") => { if (!value) throw new ReaderFailure(code); };
const reasonOf = (error, fallback) => error instanceof ReaderFailure ? error.code : fallback;
const inside = (root, value) => value === root || (path.relative(root, value) !== ".." && !path.relative(root, value).startsWith(`..${path.sep}`) && !path.isAbsolute(path.relative(root, value)));

function canonical(value, depth = 0, budget = { nodes: 0 }) {
  requireValue(depth <= 20 && ++budget.nodes <= 8192);
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") { requireValue(Number.isFinite(value)); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, depth + 1, budget)).join(",")}]`;
  requireValue(object(value));
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key], depth + 1, budget)}`).join(",")}}`;
}

function validate(request) {
  requireValue(object(request) && request.version === 1 && UUID.test(request.nativeSessionId));
  requireValue(typeof request.nativeHome === "string" && path.isAbsolute(request.nativeHome));
  requireValue(typeof request.executionHome === "string" && path.isAbsolute(request.executionHome));
  requireValue(typeof request.cwd === "string" && path.isAbsolute(request.cwd));
  requireValue(Array.isArray(request.children) && request.children.length > 0 && request.children.length <= 8);
  const agents = new Set(), calls = new Set();
  for (const child of request.children) {
    requireValue(object(child) && identifier(child.agentId) && !agents.has(child.agentId)); agents.add(child.agentId);
    requireValue(identifier(child.parentToolUseId) && typeof child.transcriptPath === "string" && path.isAbsolute(child.transcriptPath));
    requireValue(Array.isArray(child.calls) && child.calls.length > 0 && child.calls.length <= 16);
    for (const call of child.calls) {
      requireValue(object(call) && UUID.test(call.assistantUuid) && identifier(call.toolUseId) && !calls.has(call.toolUseId)); calls.add(call.toolUseId);
      requireValue(typeof call.assistantMessageId === "string" && call.assistantMessageId.length > 0 && call.assistantMessageId.length <= 512);
      requireValue(object(call.input) && typeof call.input.command === "string" && call.input.command.length > 0);
      requireValue(call.input.run_in_background === undefined || call.input.run_in_background === false);
      requireValue(Buffer.byteLength(canonical(call.input)) <= 65536);
    }
  }
  requireValue(calls.size <= 16);
  return request;
}

function fingerprint(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(":");
}

async function exactPath(file, kind, maximum) {
  requireValue(path.resolve(file) === file, "file_guard_failed");
  let current = path.parse(file).root;
  const pieces = file.slice(current.length).split(path.sep).filter(Boolean);
  for (let index = 0; index < pieces.length; index++) {
    current = path.join(current, pieces[index]);
    const stat = await lstat(current, { bigint: true });
    requireValue(!stat.isSymbolicLink(), "file_guard_failed");
    if (index < pieces.length - 1 || kind === "directory") requireValue(stat.isDirectory(), "file_guard_failed");
    else requireValue(stat.isFile() && stat.nlink === 1n && stat.size > 0n && (maximum === undefined || stat.size <= BigInt(maximum)), "file_guard_failed");
  }
  requireValue(await realpath(file) === file, "file_guard_failed");
  return fingerprint(await lstat(file, { bigint: true }));
}

async function boundedInventory(directory) {
  const entries = [];
  const handle = await opendir(directory);
  try {
    for await (const entry of handle) {
      // The pinned SDK internally inventories this known session recursively.
      // Reject nested/linked/large inventories so it cannot select an unguarded
      // duplicate child. This is metadata validation, not agent discovery.
      requireValue(entries.length < 256 && entry.isFile() && !entry.isSymbolicLink(), "unsupported_layout");
      entries.push(entry.name);
    }
  } finally { await handle.close().catch(() => {}); }
  return entries.sort().join("\n");
}

async function guard(request, child) {
  requireValue(process.env.HOME === request.nativeHome && process.env.CLAUDE_CONFIG_DIR === request.nativeHome, "environment_mismatch");
  requireValue(process.cwd() === request.cwd, "cwd_mismatch");
  const cwd = await exactPath(request.cwd, "directory"), home = await exactPath(request.nativeHome, "directory");
  const executionHome = await exactPath(request.executionHome, "directory");
  const durableProjects = path.join(request.nativeHome, "projects");
  const projectsIdentity = await exactPath(durableProjects, "directory");
  // The execution creates this one explicit link. All durable components and
  // every other execution-home ancestor remain canonical and link-free.
  const executionProjects = path.join(request.executionHome, "projects");
  const linkStat = await lstat(executionProjects, { bigint: true });
  requireValue(linkStat.isSymbolicLink() && linkStat.nlink === 1n
    && await readlink(executionProjects) === durableProjects
    && await realpath(executionProjects) === durableProjects, "file_guard_failed");
  const projectsLinkIdentity = fingerprint(linkStat);
  const encoded = request.cwd.replace(/[^a-zA-Z0-9]/g, "-");
  // The SDK hashes longer project names and can search relocated worktrees.
  // Unsupported layouts remain unproven instead of cloning those heuristics.
  requireValue(encoded.length <= 200, "unsupported_layout");
  const project = path.join(durableProjects, encoded);
  const root = path.join(project, `${request.nativeSessionId}.jsonl`);
  const directory = path.join(project, request.nativeSessionId, "subagents");
  const transcript = path.join(directory, `agent-${child.agentId}.jsonl`);
  const sidecar = transcript.replace(/\.jsonl$/, ".meta.json");
  requireValue(inside(request.nativeHome, transcript), "unsupported_layout");
  const logicalRoot = path.join(executionProjects, encoded, `${request.nativeSessionId}.jsonl`);
  const logicalTranscript = path.join(executionProjects, encoded, request.nativeSessionId, "subagents", `agent-${child.agentId}.jsonl`);
  requireValue([root, transcript, logicalRoot, logicalTranscript].includes(child.transcriptPath), "captured_path_mismatch");
  const rootIdentity = await exactPath(root, "file");
  const directoryIdentity = await exactPath(directory, "directory");
  const inventory = await boundedInventory(directory);
  const transcriptIdentity = await exactPath(transcript, "file", TRANSCRIPT_BYTES);
  const sidecarIdentity = await exactPath(sidecar, "file", SIDECAR_BYTES);
  return JSON.stringify({ cwd, home, executionHome, projectsIdentity, projectsLinkIdentity,
    rootIdentity, directoryIdentity, inventory, transcriptIdentity, sidecarIdentity });
}

function matchedMessages(request, child, messages) {
  requireValue(Array.isArray(messages) && messages.length <= 128, "unsupported_history");
  const uuids = new Set();
  for (const message of messages) {
    requireValue(object(message) && ["user", "assistant"].includes(message.type) && UUID.test(message.uuid) && !uuids.has(message.uuid), "unsupported_history");
    uuids.add(message.uuid);
    requireValue(message.session_id === request.nativeSessionId && message.parent_tool_use_id === child.parentToolUseId && message.parent_agent_id === null, "history_lineage_mismatch");
    requireValue(object(message.message) && (Array.isArray(message.message.content) || typeof message.message.content === "string"), "unsupported_history");
  }
  const matches = []; let reason;
  for (const call of child.calls) {
    const uses = [], results = [];
    messages.forEach((message, index) => {
      for (const block of Array.isArray(message.message.content) ? message.message.content : []) {
        if (!object(block)) continue;
        if (block.type === "tool_use" && block.id === call.toolUseId) uses.push({ message, block, index });
        if (block.type === "tool_result" && block.tool_use_id === call.toolUseId) results.push({ message, block, index });
      }
    });
    if (uses.length !== 1 || results.length !== 1) {
      reason ??= uses.length > 1 || results.length > 1 ? "tool_pair_ambiguous" : uses.length === 0 ? "assistant_message_mismatch" : "terminal_unavailable";
      continue;
    }
    const use = uses[0], result = results[0];
    // The pinned CLI splits a multi-block assistant message into stream frames
    // with derived block UUIDs; the history API retains the original UUID.
    // The API message.id survives that split and binds this exact tool block.
    if (use.message.type !== "assistant" || use.message.message.id !== call.assistantMessageId || use.block.name !== "Bash") {
      reason ??= "assistant_message_mismatch"; continue;
    }
    let observedInput;
    try { observedInput = canonical(use.block.input); }
    catch { throw new ReaderFailure("tool_input_mismatch"); }
    if (observedInput !== canonical(call.input)) { reason ??= "tool_input_mismatch"; continue; }
    if (result.message.type !== "user" || result.index <= use.index || result.block.is_error !== true
      || typeof result.block.content !== "string" || Buffer.byteLength(result.block.content) > 32768) {
      reason ??= "terminal_unavailable"; continue;
    }
    const terminal = { type: "tool_result", tool_use_id: call.toolUseId, content: result.block.content, is_error: true };
    // Keep the actual error content. Its text is never parsed as an interrupt,
    // command exit code, success, or evidence that another effect stopped.
    canonical(terminal);
    matches.push({ agentId: child.agentId, parentToolUseId: child.parentToolUseId, assistantUuid: call.assistantUuid,
      assistantMessageId: use.message.message.id, historyAssistantUuid: use.message.uuid,
      toolUseId: call.toolUseId, resultUuid: result.message.uuid, result: terminal });
  }
  return { matches, reason };
}

async function main() {
  const chunks = []; let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length; requireValue(bytes <= REQUEST_BYTES); chunks.push(chunk);
  }
  const request = validate(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  const response = { version: 1, nativeSessionId: request.nativeSessionId, matches: [], unavailable: [] };
  let sdk;
  for (const child of request.children) {
    try {
      const before = await guard(request, child);
      try { sdk ??= await import("@anthropic-ai/claude-agent-sdk"); }
      catch { throw new ReaderFailure("sdk_unavailable"); }
      requireValue(typeof sdk.getSubagentMessages === "function", "sdk_unavailable");
      let messages;
      try { messages = await sdk.getSubagentMessages(request.nativeSessionId, child.agentId, { dir: request.cwd, limit: 128, offset: 0 }); }
      catch { throw new ReaderFailure("sdk_read_failed"); }
      try { requireValue(await guard(request, child) === before, "read_set_changed"); }
      catch { throw new ReaderFailure("read_set_changed"); }
      let { matches, reason } = matchedMessages(request, child, messages);
      for (const match of matches) {
        if (Buffer.byteLength(JSON.stringify({ ...response, matches: [...response.matches, match] })) > OUTPUT_BYTES - 2048) {
          reason ??= "output_limit"; break;
        }
        response.matches.push(match);
      }
      if (reason) response.unavailable.push({ agentId: child.agentId, reason });
    } catch (error) { response.unavailable.push({ agentId: child.agentId, reason: reasonOf(error, "file_guard_failed") }); }
  }
  const output = JSON.stringify(response);
  requireValue(Buffer.byteLength(output) <= OUTPUT_BYTES);
  process.stdout.write(output);
}

main().catch(() => {
  process.stdout.write(JSON.stringify({ version: 1, nativeSessionId: null, matches: [], unavailable: [], error: "invalid_request" }));
  process.exitCode = 1;
});
