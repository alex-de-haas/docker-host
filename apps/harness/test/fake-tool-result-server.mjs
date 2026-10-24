// Pinned v2 result shapes; no provider credentials, network or model turns.
import readline from "node:readline";
const input = readline.createInterface({ input: process.stdin });
let turn = 0;
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
const notify = (item, turnId, threadId = "thread") => send({ method: "item/completed", params: { threadId, turnId, item } });
const mcp = (id, extra = {}) => ({ type: "mcpToolCall", id, server: "hosty-core", tool: "list_apps", arguments: {}, status: "completed",
  result: { content: [{ type: "text", text: "app output" }], structuredContent: { apps: ["demo"] }, _meta: { accessToken: "private-envelope-token" } }, error: null, ...extra });
input.on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: {} });
  if (message.method === "thread/start") return send({ id: message.id, result: { threadId: "thread" } });
  if (message.method === "turn/interrupt") return send({ id: message.id, result: {} });
  if (message.method !== "turn/start") return;
  const turnId = `turn-${++turn}`;
  send({ id: message.id, result: { turn: { id: turnId } } });
  send({ method: "turn/started", params: { threadId: "thread", turn: { id: turnId } } });
  notify(mcp("other-thread"), turnId, "other"); notify(mcp("other-turn"), "previous");
  notify(mcp("apps"), turnId); notify(mcp("apps"), turnId);
  notify(mcp("error", { status: "failed", result: null, error: { message: "app unavailable", accessToken: "private-error-token" } }), turnId);
  notify(mcp("contradictory", { error: { message: "MCP error despite completed status" } }), turnId);
  notify(mcp("missing", { result: null }), turnId);
  notify(mcp("setup", { server: "hosty-workspaces", tool: "environment_setup", result: { content: [{ type: "text", text: "private setup output" }] } }), turnId);
  notify({ type: "dynamicToolCall", id: "dynamic", namespace: "fixture", tool: "read", arguments: {}, status: "completed", success: true,
    contentItems: [{ type: "inputText", text: "dynamic output" }, { type: "inputImage", imageUrl: "data:image/png;base64,private-binary" }] }, turnId);
  notify({ type: "dynamicToolCall", id: "unknown", tool: "read", arguments: {}, status: "completed", success: null, contentItems: [] }, turnId);
  send({ method: "turn/completed", params: { threadId: "thread", turn: { id: turnId, status: "completed" } } });
  notify(mcp("late"), turnId);
});
