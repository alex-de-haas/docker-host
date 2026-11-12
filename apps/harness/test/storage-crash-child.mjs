import path from "node:path";
import { openSync, writeSync, fsyncSync, closeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { SessionStore } from "../src/sessions/store.ts";
import { SessionManager } from "../src/sessions/manager.ts";
import { AuditReporter } from "../src/audit.ts";

const [root, stage] = process.argv.slice(2);
if (!root || !stage || !process.send) throw new Error("This synthetic crash fixture requires its parent IPC channel.");
const store = new SessionStore(root), requestId = randomUUID();
const adapter = { name: "crash-fixture", capabilities: { questions: false, appMcp: false, liveReconfigure: false, autoAllow: false, denyReason: false },
  probe: async () => ({ available: true }), start: () => ({
    send: () => {
      const file = openSync(path.join(root, "synthetic-effects"), "a");
      try { writeSync(file, "one\n"); fsyncSync(file); } finally { closeSync(file); }
    }, stop: async () => {}, stopAndWait: async () => {}, interrupt: async () => {},
    resolveApproval: () => false, resolveQuestion: () => false, setMcpServers: async () => false,
  }) };
const manager = new SessionManager(store, adapter, new AuditReporter(null, null, "crash-fixture"), root);
const session = await manager.createSession({ createdBy: "owner" });
const stopAtBoundary = async () => {
  process.send({ sessionId: session.id, requestId, stage });
  setInterval(() => {}, 1000);
  await new Promise(() => {});
};
const save = store.saveRecord.bind(store);
store.saveRecord = async record => {
  await save(record);
  if (stage === "preparing" && record.sourceAdmission?.state === "preparing") await stopAtBoundary();
};
const append = store.appendEvent.bind(store);
store.appendEvent = async (id, event, allocation) => {
  await append(id, event, allocation);
  if (stage === "input" && event.type === "user_message") await stopAtBoundary();
};
const receipt = store.saveMessageReceipt.bind(store);
store.saveMessageReceipt = async (id, value) => {
  if (stage === "before-acceptance" && value.state === "accepted") await stopAtBoundary();
  await receipt(id, value);
  if (stage === "after-acceptance" && value.state === "accepted") await stopAtBoundary();
};
await manager.postMessage(session.id, "Synthetic durable input", undefined, [], {
  clientRequestId: requestId, actorUserId: "owner", expectedRevision: 0, selectionRevision: 0, withoutDetails: false,
});
throw new Error("The requested crash boundary was not reached.");
