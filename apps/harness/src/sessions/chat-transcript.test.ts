import { afterEach, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ChatTranscript } from "./chat-transcript.js";
import type { HistoryReceipt } from "../agent-providers/history-coverage.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const provider = { appId: "a", installationId: "i", key: "k" };
const observation = (sessionPosition: number): HistoryReceipt => ({ sessionPosition, sessionId: "chat", epoch: "e", cursor: "c" + sessionPosition,
  principalId: "owner", userId: "owner", runId: "run", generation: "g", item: { kind: "event", cursor: "r" + sessionPosition, event: { schemaVersion: "agent-event.1",
    runId: "run", generation: "g", occurredAt: "2026-11-25T00:00:00Z", sequence: String(sessionPosition), revision: "1",
    type: "message.delta", data: { text: "token" + sessionPosition }, source: { agentId: "root" } } } });
async function create() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hosty-chat-")); dirs.push(dir);
  const file = path.join(dir, "chat.sqlite"), chat = new ChatTranscript(file); chat.create(); return { chat, file };
}

it("acknowledges only a contiguous durable prefix, including sparse delivery, restart, lost receipt and duplicates", async () => {
  const { chat, file } = await create();
  chat.projected(chat.receive(provider, observation(3))!);
  expect(chat.acknowledgements(provider)).toEqual([]);
  chat.receive(provider, observation(1));
  const reopened = new ChatTranscript(file);
  expect(reopened.pending().map(i => i.ordinal)).toEqual([1]);
  const first = reopened.acknowledgements(provider)[0]!;
  expect(first.through).toBe(1);
  expect(reopened.acknowledgements({ ...provider, implementationId: "another" })).toEqual([]);
  reopened.receive(provider, observation(2));
  expect(reopened.acknowledgements(provider)[0]?.through).toBe(3);
  reopened.acknowledged(provider, first);
  expect(reopened.acknowledgements(provider)[0]?.through).toBe(3);
  for (const item of reopened.pending()) reopened.projected(item);
  expect(reopened.receive(provider, observation(3))).toBeUndefined();
  expect(reopened.pending()).toEqual([]);
  reopened.acknowledged(provider, { ...first, through: 3 });
  expect(reopened.acknowledgements(provider)).toEqual([]);
});

it("rolls back transcript intake and the delivery cursor together after a write failure", async () => {
  const { chat, file } = await create(), sql = new DatabaseSync(file);
  sql.exec("CREATE TRIGGER fault BEFORE UPDATE OF received ON streams BEGIN SELECT RAISE(ABORT, 'interrupted'); END"); sql.close();
  expect(() => chat.receive(provider, observation(1))).toThrow("interrupted");
  expect(chat.pending()).toEqual([]);
  expect(chat.acknowledgements(provider)).toEqual([]);
  const repaired = new DatabaseSync(file); repaired.exec("DROP TRIGGER fault"); repaired.close();
  chat.receive(provider, observation(1));
  expect(chat.pending()[0]?.fact).toEqual(observation(1));
  expect(chat.acknowledgements(provider)[0]?.through).toBe(1);
});

it("keeps a missing canonical chat database missing on reads and imports", async () => {
  const { chat, file } = await create();
  await rm(file);
  expect(() => chat.read(0)).toThrow();
  expect(() => chat.receive(provider, observation(1))).toThrow();
  await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
});

it("resumes a transcript after its fragments and returns the complete final at the requested cursor", async () => {
  const { chat, file } = await create();
  const target = "run:message:root:m";
  const fragments = [["start", ""], [undefined, "exact "], [undefined, "reply"], ["complete", ""]] as const;
  for (const [index, [messageBoundary, text]] of fragments.entries())
    chat.append({ seq: index + 1, ts: "", type: "provider_fragment", target, sourceSequence: String(index + 1), messageBoundary, text });
  chat.append({ seq: 5, ts: "", type: "assistant_text", providerEventId: target, text: "excerpt" });
  expect(new ChatTranscript(file).read(4)).toMatchObject([{ seq: 5, type: "assistant_text", text: "exact reply" }]);
});
