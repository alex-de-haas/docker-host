#!/usr/bin/env node
// A scripted stand-in for `codex app-server`, used by the Codex adapter tests. It speaks the same
// stdio JSON-RPC dialect the 2026-08-09 spike observed, including the quirks the adapter must
// respect — so a regression in the adapter's wire handling fails here instead of on a live host.
//
// Scripted behavior, driven by the turn's text:
//   * "write"  -> raises a fileChange approval request and waits; on allow it emits a tool item and
//                 finishes, on deny it says so and finishes.
//   * "hello"  -> streams two agent-message deltas and finishes.
//   * anything else -> finishes immediately.
// Strict protocol checks (a wrong shape exits non-zero, failing the test loudly):
//   * thread/start must pass `sandbox` as a string; turn/start must pass `sandboxPolicy` as an
//     internally tagged object.
//   * an approval reply must never be "approved_for_session".

let buffer = "";
let pendingApprovalId = null;
let currentTurnText = "";

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  for (let nl; (nl = buffer.indexOf("\n")) >= 0; ) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line) handle(JSON.parse(line));
  }
});

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
function fail(reason) {
  process.stderr.write(`FAKE-CODEX PROTOCOL VIOLATION: ${reason}\n`);
  process.exit(3);
}

function handle(msg) {
  // Reply to an approval we raised.
  if (msg.id !== undefined && msg.result !== undefined && msg.id === pendingApprovalId) {
    const decision = msg.result?.decision;
    if (decision === "approved_for_session") {
      fail("adapter sent approved_for_session, which grants blanket approval");
    }
    pendingApprovalId = null;
    // Live Codex emits item/completed even for a REFUSED item, so the fake does too — the adapter
    // must suppress the tool_use in that case or the transcript claims a denied action ran.
    send({
      jsonrpc: "2.0",
      method: "item/completed",
      params: { item: { type: "fileChange", id: "exec-1", changes: [{ path: "/tmp/x", kind: { type: "add" } }] } },
    });
    const allowed = decision === "approved";
    send({
      jsonrpc: "2.0",
      method: "item/completed",
      params: { item: { type: "agentMessage", id: "msg-1", text: allowed ? "written" : "skipped" } },
    });
    send({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "t1", turn: { id: "turn-1" } } });
    return;
  }

  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { userAgent: "fake-codex" } });
    return;
  }
  if (msg.method === "initialized") return;

  if (msg.method === "thread/start") {
    if (typeof msg.params?.sandbox !== "string") {
      fail("thread/start sandbox must be a plain string");
    }
    send({ jsonrpc: "2.0", id: msg.id, result: { threadId: "thread-fake-1" } });
    return;
  }

  if (msg.method === "thread/resume") {
    send({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: msg.params?.threadId ?? "thread-fake-1" } } });
    return;
  }

  if (msg.method === "turn/start") {
    const policy = msg.params?.sandboxPolicy;
    if (typeof policy !== "object" || policy === null || typeof policy.type !== "string") {
      fail("turn/start sandboxPolicy must be an internally tagged object");
    }
    currentTurnText = String(msg.params?.input?.[0]?.text ?? "");
    send({ jsonrpc: "2.0", id: msg.id, result: {} });

    if (currentTurnText.includes("write")) {
      pendingApprovalId = 9000;
      send({
        jsonrpc: "2.0",
        id: pendingApprovalId,
        method: "item/fileChange/requestApproval",
        params: { threadId: "thread-fake-1", itemId: "exec-1", changes: [{ path: "/tmp/x" }], reason: null },
      });
      return;
    }

    if (currentTurnText.includes("hello")) {
      send({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { delta: "he" } });
      send({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { delta: "llo" } });
      send({ jsonrpc: "2.0", method: "item/completed", params: { item: { type: "agentMessage", id: "m", text: "hello" } } });
    }
    send({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "t1", turn: { id: "turn-1" } } });
    return;
  }

  if (msg.method === "turn/interrupt") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
}
