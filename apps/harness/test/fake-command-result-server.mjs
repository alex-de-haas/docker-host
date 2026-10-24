#!/usr/bin/env node
// Exact v2 lifecycle fields from the pinned app-server generate-ts command; never a live provider.
import readline from "node:readline";
const input = readline.createInterface({ input: process.stdin });
let turn = 0, deniedTurn;
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
const event = (method, item, turnId) => send({ method, params: { threadId: "thread", turnId, item } });
const complete = (id, nativeTurn, extra = {}) => event("item/completed", { type: "commandExecution", id, command: "fixture", status: "completed", exitCode: 0, durationMs: 4200, aggregatedOutput: "secret\nTests 14 passed (14)\nsecret", ...extra }, nativeTurn);
const start = (id, nativeTurn) => event("item/started", { type: "commandExecution", id, command: "fixture", status: "inProgress" }, nativeTurn);
const finish = nativeTurn => send({ method: "turn/completed", params: { threadId: "thread", turn: { id: nativeTurn, status: "completed" } } });
input.on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: {} });
  if (message.method === "thread/start") return send({ id: message.id, result: { threadId: "thread" } });
  if (message.method === "turn/start") {
    const nativeTurn = `turn-${++turn}`;
    send({ id: message.id, result: { turn: { id: nativeTurn } } });
    send({ method: "turn/started", params: { threadId: "thread", turn: { id: nativeTurn } } });
    const prompt = message.params.input[0].text;
    if (prompt === "denied") {
      start("denied", nativeTurn); deniedTurn = nativeTurn;
      send({ id: "approve", method: "item/commandExecution/requestApproval", params: { threadId: "thread", turnId: nativeTurn, itemId: "denied", command: "fixture" } });
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
  if (message.method === "turn/interrupt") return send({ id: message.id, result: {} });
});
