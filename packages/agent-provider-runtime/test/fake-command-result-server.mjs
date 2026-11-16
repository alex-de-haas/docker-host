#!/usr/bin/env node
// Exact v2 lifecycle fields from the pinned app-server generate-ts command; never a live provider.
import readline from "node:readline";
const input = readline.createInterface({ input: process.stdin });
let turn = 0, deniedTurn, allowedTurn, interruptedCommand, backgroundCommand, cleanupMode;
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
const event = (method, item, turnId) => send({ method, params: { threadId: "thread", turnId, item } });
const complete = (id, nativeTurn, extra = {}) => event("item/completed", { type: "commandExecution", id, command: "fixture", status: "completed", exitCode: 0, durationMs: 4200, aggregatedOutput: "secret\nTests 14 passed (14)\nsecret", ...extra }, nativeTurn);
const start = (id, nativeTurn) => event("item/started", { type: "commandExecution", id, command: "fixture", status: "inProgress" }, nativeTurn);
const finish = (nativeTurn, status = "completed") => send({ method: "turn/completed", params: { threadId: "thread", turn: { id: nativeTurn, status } } });
input.on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: {} });
  if (message.method === "thread/start") return send({ id: message.id, result: { threadId: "thread" } });
  if (message.method === "turn/interrupt") {
    if (message.params?.threadId !== "thread" || message.params?.turnId !== interruptedCommand) throw new Error("Interrupt must name the exact active turn.");
    send({ id: message.id, result: {} });
    // Pinned rust-v0.167.0 thread_history.rs::handle_exec_command_end explicitly
    // permits command terminal events after turn/completed. Interrupt does not clean PTYs.
    finish(interruptedCommand, "interrupted");
    return;
  }
  if (message.method === "thread/backgroundTerminals/clean") {
    if (message.params?.threadId !== "thread") throw new Error("Cleanup must name the owned thread.");
    if (cleanupMode === "fail") return send({ id: message.id, error: { code: -32601, message: "Fixture cleanup unavailable" } });
    send({ id: message.id, result: {} });
    if (cleanupMode === "ack-only") return;
    const pending = interruptedCommand ?? backgroundCommand;
    if (pending) setTimeout(() => {
      // Foreign, wrong-turn and unknown item events cannot settle the retained command.
      send({ method: "item/completed", params: { threadId: "foreign", turnId: pending, item: { type: "commandExecution", id: "interrupting-command", status: "completed", exitCode: 0 } } });
      complete("interrupting-command", "foreign-turn"); complete("foreign-item", pending);
      event("item/completed", { type: "mcpToolCall", id: "remote", server: "external", tool: "write", status: "completed", result: { content: [] } }, pending);
      complete("interrupting-command", pending, { status: "failed", exitCode: 130, durationMs: 75, aggregatedOutput: "" });
      interruptedCommand = backgroundCommand = undefined;
    }, 75);
    return;
  }
  if (message.method === "turn/start") {
    const nativeTurn = `turn-${++turn}`;
    send({ id: message.id, result: { turn: { id: nativeTurn } } });
    send({ method: "turn/started", params: { threadId: "thread", turn: { id: nativeTurn } } });
    const prompt = message.params.input[0].text;
    if (["interrupt-drain", "background-drain", "cleanup-ack-only", "cleanup-fail", "background-with-remote"].includes(prompt)) {
      cleanupMode = prompt === "cleanup-ack-only" ? "ack-only" : prompt === "cleanup-fail" ? "fail" : undefined;
      start("interrupting-command", nativeTurn);
      if (prompt === "background-with-remote") event("item/started", { type: "mcpToolCall", id: "remote", server: "external", tool: "write", status: "inProgress" }, nativeTurn);
      if (prompt === "interrupt-drain") interruptedCommand = nativeTurn;
      else { backgroundCommand = nativeTurn; finish(nativeTurn); }
      return;
    }
    if (prompt === "denied") {
      start("denied", nativeTurn); deniedTurn = nativeTurn;
      send({ id: "approve", method: "item/commandExecution/requestApproval", params: { threadId: "thread", turnId: nativeTurn, itemId: "denied", command: "fixture" } });
      return;
    }
    if (prompt === "allowed") {
      start("allowed", nativeTurn); allowedTurn = nativeTurn;
      send({ id: "approve-allowed", method: "item/commandExecution/requestApproval", params: { threadId: "thread", turnId: nativeTurn, itemId: "allowed", command: "fixture" } });
      return;
    }
    // A stray previous turn start must not replace the current factual turn identity.
    send({ method: "turn/started", params: { threadId: "thread", turn: { id: "previous" } } });
    start("old", "previous"); complete("old", "previous");
    start("ok", nativeTurn); complete("ok", nativeTurn); complete("ok", nativeTurn, { status: "failed", exitCode: 2 });
    start("failed", nativeTurn); complete("failed", nativeTurn, { status: "failed", exitCode: 2, aggregatedOutput: "token=secret", durationMs: 12 });
    start("unknown", nativeTurn); complete("unknown", nativeTurn, { exitCode: null });
    start("declined", nativeTurn); complete("declined", nativeTurn, { status: "declined", exitCode: null });
    complete("no-start", nativeTurn);
    finish(nativeTurn); complete("late", nativeTurn); return;
  }
  if (message.id === "approve") {
    // Even a provider that reports a refused command twice as completed cannot override Hosty denial.
    complete("denied", deniedTurn); complete("denied", deniedTurn); finish(deniedTurn); return;
  }
  if (message.id === "approve-allowed") { complete("allowed", allowedTurn); finish(allowedTurn); return; }
  if (message.method === "turn/interrupt") return send({ id: message.id, result: {} });
});
