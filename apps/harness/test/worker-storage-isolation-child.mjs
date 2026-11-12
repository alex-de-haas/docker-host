import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { syncBuiltinESMExports } from "node:module";
import { WorkerJournal } from "../src/worker/journal.ts";
import { WorkerEngine } from "../src/worker/engine.ts";

const [root, exitMode] = process.argv.slice(2);
if (!root || !["confirmed", "unconfirmed", "pending", "unsupported"].includes(exitMode) || !process.send) throw new Error("This isolated Worker fixture requires parent IPC and a private directory.");
const journal = new WorkerJournal(root); await journal.initialize();
const starts = new Map(), stops = new Map(), releases = new Map(), sends = new Map();
let allowStop = exitMode === "confirmed", injectFailure = false, faults = 0, configurations = 0, releaseStop;
const rename = fs.rename;
fs.rename = async (from, to) => {
  if (injectFailure && to === path.join(root, "damaged.json")) {
    injectFailure = false; faults++;
    throw Object.assign(new Error("synthetic rename failure"), { code: "EIO" });
  }
  return rename(from, to);
};
syncBuiltinESMExports();
const request = id => ({ conversationId: id, binding: { connectionId: id, connectionRevision: 1, harnessKind: "codex" },
  selection: { model: null, reasoningEffort: null }, resource: { kind: "conversation", id }, input: "synthetic input", options: {}, autoAllowedPrefixes: [] });
const engine = new WorkerEngine(journal, {
  validateSelection: async () => {}, cwd: async () => root,
  reserve: async input => () => releases.set(input.conversationId, (releases.get(input.conversationId) ?? 0) + 1),
  adapter: async () => ({ name: "isolation-fixture", capabilities: { questions: false, appMcp: false, liveReconfigure: false, autoAllow: false, denyReason: false },
    probe: async () => ({ available: true }), start: options => {
      starts.set(options.sessionId, options);
      const run = { send() { sends.set(options.sessionId, (sends.get(options.sessionId) ?? 0) + 1); }, interrupt: async () => {},
        stop: async () => { if (options.sessionId === "damaged" && exitMode === "unsupported") stops.set("damaged", (stops.get("damaged") ?? 0) + 1); },
        stopAndWait: async () => {
          stops.set(options.sessionId, (stops.get(options.sessionId) ?? 0) + 1);
          if (options.sessionId === "damaged" && !allowStop) {
            if (exitMode === "pending") await new Promise(resolve => { releaseStop = resolve; });
            else throw new Error("synthetic native exit remains unconfirmed");
          }
        }, resolveApproval: () => false, resolveQuestion: () => false, setMcpServers: async () => { configurations++; return false; } };
      if (options.sessionId === "damaged" && exitMode === "unsupported") delete run.stopAndWait;
      return run;
    } }),
}, 2);
const wait = async predicate => {
  const until = Date.now() + 5000;
  while (!await predicate()) { if (Date.now() > until) throw new Error("Worker fixture condition timed out"); await new Promise(resolve => setTimeout(resolve, 10)); }
};
try {
  await engine.submit("damaged", request("damaged")); await engine.submit("healthy", request("healthy"));
  await wait(() => starts.size === 2);
  injectFailure = true;
  starts.get("damaged").onEvent({ type: "assistant_text", text: "unsaved output" });
  await wait(() => stops.get("damaged") === 1);
  await new Promise(resolve => setTimeout(resolve, 1200)); // Cross a real usage-sampling tick under default Node rejection handling.
  assert.equal(engine.available, true);
  assert.equal(engine.occupied, exitMode === "confirmed" ? 1 : 2);
  assert.equal(releases.get("damaged") ?? 0, exitMode === "confirmed" ? 1 : 0);
  assert.equal(stops.get("damaged"), 1);
  await assert.rejects(engine.configure("damaged", {}), { code: "run_storage_uncertain" });
  assert.equal(configurations, 0);
  await assert.rejects(journal.load("damaged"), { code: "run_storage_uncertain" });
  await assert.rejects(engine.submit("damaged", request("damaged")), { code: "run_storage_uncertain" });
  const raw = JSON.parse(await fs.readFile(path.join(root, "damaged.json"), "utf8"));
  assert.equal(raw.receipt.state, "running"); assert.equal(raw.receipt.exitConfirmed, undefined); assert.equal(raw.events.length, 0);
  starts.get("damaged").onEvent({ type: "result", status: "success" });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(stops.get("damaged"), 1); // Late provider frames cannot retry an unconfirmed stop.
  starts.get("healthy").onEvent({ type: "assistant_text", text: "healthy output" });
  starts.get("healthy").onEvent({ type: "result", status: "success" });
  await wait(async () => (await journal.load("healthy")).receipt.state === "completed");
  assert.equal(releases.get("healthy"), 1);
  if (exitMode !== "confirmed") {
    allowStop = true;
    const cancellation = engine.cancel("damaged", "explicit-stop-retry");
    releaseStop?.();
    await assert.rejects(cancellation, { code: "run_storage_uncertain" });
    assert.equal(stops.get("damaged"), exitMode === "pending" ? 1 : 2);
    assert.equal(releases.get("damaged") ?? 0, exitMode === "unsupported" ? 0 : 1);
    assert.equal(engine.occupied, exitMode === "unsupported" ? 1 : 0);
  }
  const reopened = new WorkerJournal(root); await reopened.initialize();
  assert.equal((await reopened.load("damaged")).receipt.state, "interrupted");
  assert.equal((await reopened.accept("damaged", request("damaged"))).fresh, false);
  assert.equal(sends.get("damaged"), 1); assert.equal(sends.get("healthy"), 1); assert.equal(faults, 1);
  process.send({ survived: true, healthy: "completed", damaged: "interrupted", faults, sends: [...sends], releases: [...releases] });
} finally {
  allowStop = true; releaseStop?.(); await engine.close(); fs.rename = rename; syncBuiltinESMExports();
}
