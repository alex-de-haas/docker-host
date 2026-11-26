import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { ProviderStore, type VerifiedOperation } from "./store.js";
import { projectEvent, projectReceipt } from "./projection.js";
import { automaticParkId, NATIVE_QUESTION_PARK_MS, overdueBlockingQuestion } from "./native-parking.js";
import type { WorkerEvent, WorkerReceipt } from "./internal/worker/contracts.js";
const directories: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(directories.splice(0).map(value => rm(value, { recursive: true, force: true }))); });
async function fixture(blocking = true) {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-12T12:00:00Z"));
  const directory = await mkdtemp(path.join(os.tmpdir(), "hosty-native-parking-")); directories.push(directory);
  const provider = { appId: "independent.provider", installationId: "installed", key: "native" };
  const actor: VerifiedOperation = { userId: "owner", principalId: "original", callerAppId: "different.consumer", callerInstallation: "consumer", provider, admissionRef: "admitted", operation: "runs.start" };
  const store = new ProviderStore(directory, provider); await store.initialize();
  const id = randomUUID(), configuration = { connection: { id: "account", revision: "1" } };
  await store.create(id, actor, "{}", { configuration }, { configuration, digest: "a".repeat(64), resolvedSkills: [] });
  const session = await store.load(id), record = store.makeRun(session, randomUUID(), actor, "{}"); session.runs[record.snapshot.ref.id] = record; session.session.activeRun = record.snapshot.ref;
  const frame: WorkerEvent = { runId: record.snapshot.ref.id, generation: "native-generation", sequence: 5,
    event: { type: "question_request", questionId: "q", blocking, questions: [{ id: "choice", question: "Continue?", header: "Choice", multiSelect: false, allowText: true, options: [] }] } };
  projectEvent(store, session, record, frame);
  const receipt: WorkerReceipt = { runId: record.snapshot.ref.id, conversationId: id, generation: frame.generation, revision: 6, state: blocking ? "awaiting_input" : "running", exitConfirmed: false,
    pending: [frame], snapshot: { nativeSessionId: "private-native" }, selection: { model: null, reasoningEffort: null }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  projectReceipt(store, session, record, receipt); await store.save(session);
  return { store, session, record, frame, native: { receipt, events: [frame], controls: {} } };
}
it("keeps the fixed five-minute age durably and preserves exact native control identity", async () => {
  const f = await fixture(), started = Date.now(), loaded = await f.store.run(f.record.snapshot.ref.id);
  expect(overdueBlockingQuestion(loaded.record, f.native, started + NATIVE_QUESTION_PARK_MS - 1)).toBeNull();
  expect(overdueBlockingQuestion(loaded.record, f.native, started + NATIVE_QUESTION_PARK_MS)).toEqual(f.frame);
  expect(automaticParkId(f.frame.runId,f.frame.generation,f.frame.sequence)).toBe(automaticParkId(f.frame.runId,f.frame.generation,f.frame.sequence));
  expect(automaticParkId(f.frame.runId,"another-generation",f.frame.sequence)).not.toBe(automaticParkId(f.frame.runId,f.frame.generation,f.frame.sequence));
});
it("excludes nonblocking work, pending approvals, unknown/active effects and uncertain response delivery", async () => {
  const f = await fixture(), now = Date.now() + NATIVE_QUESTION_PARK_MS;
  const blocked = (change: (record: typeof f.record, native: typeof f.native) => void) => {
    const record = structuredClone(f.record), native = structuredClone(f.native); change(record,native);
    expect(overdueBlockingQuestion(record,native,now)).toBeNull();
  };
  blocked((_r,n)=>{ n.receipt.pending![0]!.event = { ...f.frame.event, blocking:false } as typeof f.frame.event; });
  blocked(r=>{ r.snapshot.pending.push({ id:"approval",revision:"1",kind:"approval",delivery:"continue_run" }); });
  blocked(r=>{ r.snapshot.effects.certainty="unknown"; });
  blocked((_r,n)=>{ n.receipt.effects={effect:"started"}; });
  blocked((_r,n)=>{ n.events.push({ ...f.frame,sequence:7,event:{type:"tool_use",toolName:"Bash",toolUseId:"active",input:{}} }); });
  blocked((_r,n)=>{ n.events.push({ ...f.frame,sequence:7,event:{type:"tool_result",toolUseId:"unknown",output:"",status:"unknown"} }); });
  blocked((_r,n)=>{ n.controls={uncertain:{applied:false}}; });
  blocked(r=>{ r.snapshot.agents=[{agentId:"other-child",state:"running"}]; });
  blocked(r=>{ r.snapshot.agents=[{agentId:"other-child",state:"waiting_for_input"}]; });
  blocked(r=>{ r.controls.answer={hash:"h",decisionId:"q",receipt:{requestId:"answer",state:"accepted",run:r.snapshot.ref,revision:"1"}}; });
  const nonblocking=await fixture(false);expect(overdueBlockingQuestion(nonblocking.record,nonblocking.native,now)).toBeNull();
});
it("turns only a confirmed parked callback into a revised next-turn decision and keeps its Core link", async () => {
  const f=await fixture();f.record.decisionLinks={q:"core-question"};const old=structuredClone(f.record.snapshot.pending[0]!);
  projectReceipt(f.store,f.session,f.record,{...f.native.receipt,state:"parked",revision:7,exitConfirmed:false});
  expect(f.record.snapshot.pending[0]).toEqual(old);
  projectReceipt(f.store,f.session,f.record,{...f.native.receipt,state:"parked",revision:8,exitConfirmed:true});
  expect(f.record.snapshot.pending[0]).toMatchObject({id:"q",revision:"6",delivery:"next_turn"});
  expect(f.record.decisionLinks).toEqual({q:"core-question"});expect(f.session.session.activeRun).toBeNull();
  const event=f.record.events.filter(event=>event.type==="decision.requested").at(-1)!;
  expect(event.data.decision).toMatchObject({revision:"6",delivery:"next_turn"});
  projectReceipt(f.store,f.session,f.record,{...f.native.receipt,state:"parked",revision:8,exitConfirmed:true});
  expect(f.record.snapshot.pending[0]?.revision).toBe("6");
});
it("cannot convert a parked receipt whose external effect certainty is unresolved", async () => {
  const f=await fixture();projectReceipt(f.store,f.session,f.record,{...f.native.receipt,state:"parked",exitConfirmed:true,effects:{unknown:"unknown"}});
  expect(f.record.snapshot).toMatchObject({stopConfirmed:true,state:"waiting_for_input",phase:"parked",effects:{certainty:"unknown"}});
  expect(f.record.snapshot.pending[0]?.delivery).toBe("continue_run");
});
