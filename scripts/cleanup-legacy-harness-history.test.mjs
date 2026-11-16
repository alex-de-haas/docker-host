import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, link, stat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { planLegacyHarnessHistory as plan, applyLegacyHarnessHistory as apply } from './cleanup-legacy-harness-history.mjs';

const owner = 'user:fixture-owner';
const observed = () => ({ sessions: [{ id: 'session-1', owner, conversation: null }], runs: [{ id: 'run-1', owner, conversation: null, stopConfirmed: true }], cancellations: [{ key: 'cancel-1', runId: 'run-1', state: 'pending' }] });
const journal = () => ({ version: 1, hash: 'a'.repeat(64), receipt: { runId: 'run-1', state: 'parked', exitConfirmed: true, effects: {}, pending: [], barrier: null }, events: [{ text: 'PRIVATE NATIVE HISTORY' }], controls: { cancel: { hash: 'b'.repeat(64), applied: true } } });
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'hosty-legacy-cleanup-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function put(relative, value) {
    const file = path.join(root, relative); await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
  }
  for (const lock of ['coordinator-owner.sqlite', 'worker-service/worker-owner.sqlite']) {
    await mkdir(path.dirname(path.join(root, lock)), { recursive: true });
    const db = new DatabaseSync(path.join(root, lock)); db.exec('CREATE TABLE IF NOT EXISTS owner (id TEXT);'); db.close();
  }
  await put('agent-observations.json', observed());
  await put('worker-service/runs/run-1.json', journal());
  await put('provider-sessions/conn-1/1/sessions/native.jsonl', 'PRIVATE NATIVE HISTORY');
  await put('worker-service/provider-sessions/conn-2/2/projects/project/session.jsonl', 'PRIVATE WORKER HISTORY');
  await mkdir(path.join(root, 'sessions'));
  const preserved = ['connections.json', 'profiles.json', 'tasks/tasks.json', 'workspaces/worktree.txt', 'cache/config.json', 'auth.json', 'agent-cursors/cursor-key', 'worker-service/connections.json', 'worker-service/agent-providers/account/auth.json'];
  for (const file of preserved) await put(file, 'PRESERVE ' + file);
  return { root, put, preserved, options: { dataDir: root, owner } };
}
async function approved(f, extra = {}) { const value = await plan(f.options); return { ...f.options, planDigest: value.digest, requestId: randomUUID(), confirmDelete: true, ...extra }; }
const errorCode = code => error => error.code === code;

test('plans without native contents and removes only reviewed legacy history; exact replay is harmless', async t => {
  const f = await fixture(t), before = await readFile(path.join(f.root, 'agent-observations.json'), 'utf8');
  const value = await plan(f.options);
  assert.equal(value.summary.retiredPendingCancellations, 1);
  assert.equal(value.summary.workerRuns, 1);
  assert.equal(JSON.stringify(value).includes('PRIVATE'), false);
  assert.equal(JSON.stringify(value).includes('native.jsonl'), false);
  assert.equal(await readFile(path.join(f.root, 'agent-observations.json'), 'utf8'), before);
  const request = { ...f.options, planDigest: value.digest, requestId: randomUUID(), confirmDelete: true };
  assert.equal((await apply(request)).state, 'completed');
  for (const target of value.targets) await assert.rejects(stat(path.join(f.root, target.path)), errorCode('ENOENT'));
  for (const file of f.preserved) assert.equal(await readFile(path.join(f.root, file), 'utf8'), 'PRESERVE ' + file);
  assert.equal((await stat(path.join(f.root, '.legacy-harness-history-cleanup.json'))).mode & 0o777, 0o600);
  assert.equal((await apply(request)).replay, true);
});

for (const lock of ['coordinator-owner.sqlite', 'worker-service/worker-owner.sqlite'])
  test('refuses cleanup while storage is owned: ' + lock, async t => {
    const f = await fixture(t), db = new DatabaseSync(path.join(f.root, lock));
    try { db.exec('PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;'); await assert.rejects(plan(f.options), errorCode('storage_in_use')); }
    finally { db.close(); }
    assert.equal((await plan(f.options)).summary.workerRuns, 1);
  });

test('any remaining global conversation blocks deletion', async t => {
  const f = await fixture(t); await f.put('sessions/foreign-conversation.json', '{}');
  await assert.rejects(plan(f.options), errorCode('conversations_remain'));
});

for (const [name, mutate, code] of [
  ['running observation', v => { v.runs[0].stopConfirmed = false; }, 'observed_execution_unsettled'],
  ['other owner', v => { v.runs[0].owner = 'other'; }, 'observed_execution_unsettled'],
  ['attached native session', v => { v.sessions[0].conversation = 'conversation'; }, 'observations_invalid'],
  ['unresolved cancellation reference', v => { v.cancellations[0].runId = 'unknown'; }, 'cancellation_unsettled'],
]) test('preserves ' + name, async t => {
  const f = await fixture(t), value = observed(); mutate(value); await f.put('agent-observations.json', value);
  await assert.rejects(plan(f.options), errorCode(code));
});

for (const [name, mutate, code = 'worker_execution_unsettled'] of [
  ['active worker run', v => { v.receipt.state = 'running'; }],
  ['unknown native exit', v => { v.receipt.exitConfirmed = false; }],
  ['malformed effect', v => { v.receipt.effects = { write: 'settled' }; }, 'worker_effects_invalid'],
  ['native callback', v => { v.receipt.pending = ['callback']; }],
  ['malformed barrier', v => { v.receipt.barrier = { native: true }; }, 'worker_barrier_invalid'],
  ['unapplied control', v => { v.controls.cancel.applied = false; }, 'worker_controls_unsettled'],
  ['malformed controls', v => { v.controls = []; }],
]) test('preserves ' + name, async t => {
  const f = await fixture(t), value = journal(); mutate(value); await f.put('worker-service/runs/run-1.json', value);
  await assert.rejects(plan(f.options), errorCode(code));
});

test('requires exact digest and explicit deletion confirmation', async t => {
  const f = await fixture(t), request = await approved(f);
  await assert.rejects(apply({ ...request, confirmDelete: false }), errorCode('confirmation_required'));
  await f.put('provider-sessions/conn-1/1/sessions/new.jsonl', 'new history');
  await assert.rejects(apply(request), errorCode('plan_changed'));
  assert.equal(await readFile(path.join(f.root, 'provider-sessions/conn-1/1/sessions/native.jsonl'), 'utf8'), 'PRIVATE NATIVE HISTORY');
});

for (const kind of ['symlink', 'hardlink']) test('refuses ' + kind + ' history', async t => {
  const f = await fixture(t), source = path.join(f.root, 'auth.json'), target = path.join(f.root, 'provider-sessions/conn-1/1/sessions/linked');
  if (kind === 'symlink') await symlink(source, target); else await link(source, target);
  await assert.rejects(plan(f.options), errorCode('unsafe_history_path'));
});

test('refuses linked data roots and unexpected native layout', async t => {
  const f = await fixture(t), alias = f.root + '-alias'; await symlink(f.root, alias); t.after(() => rm(alias));
  await assert.rejects(plan({ ...f.options, dataDir: alias }), errorCode('unsafe_data_root'));
  await f.put('provider-sessions/conn-1/1/auth.json', 'must preserve');
  await assert.rejects(plan(f.options), errorCode('native_layout_invalid'));
});

test('same pending request resumes only deletions from its immutable inventory', async t => {
  const f = await fixture(t), value = await plan(f.options), request = await approved(f);
  await apply(request);
  const receiptFile = path.join(f.root, '.legacy-harness-history-cleanup.json');
  const receipt = JSON.parse(await readFile(receiptFile, 'utf8')); receipt.state = 'pending'; await writeFile(receiptFile, JSON.stringify(receipt));
  await assert.rejects(plan(f.options), errorCode('cleanup_pending'));
  await assert.rejects(apply({ ...request, requestId: randomUUID() }), errorCode('cleanup_pending'));
  await assert.rejects(apply({ ...request, owner: 'other' }), errorCode('request_conflict'));
  assert.equal((await apply(request)).state, 'completed');
  assert.equal(value.targets.length, 4);
});

test('pending receipt never authorizes newly created native history', async t => {
  const f = await fixture(t), request = await approved(f); await apply(request);
  const receiptFile = path.join(f.root, '.legacy-harness-history-cleanup.json');
  const receipt = JSON.parse(await readFile(receiptFile, 'utf8')); receipt.state = 'pending'; await writeFile(receiptFile, JSON.stringify(receipt));
  await f.put('provider-sessions/conn-1/1/sessions/new.jsonl', 'new history');
  await assert.rejects(apply(request), errorCode('history_changed'));
  assert.equal(await readFile(path.join(f.root, 'provider-sessions/conn-1/1/sessions/new.jsonl'), 'utf8'), 'new history');
});

test('never touches a consumer already cut over to public providers', async t => {
  const f = await fixture(t); await f.put('agent-consumer-format.json', { version: 1 });
  await assert.rejects(plan(f.options), errorCode('already_cut_over'));
});


test('a corrupted retained inventory never authorizes replay', async t => {
  const f = await fixture(t), request = await approved(f); await apply(request);
  const file = path.join(f.root, '.legacy-harness-history-cleanup.json');
  const receipt = JSON.parse(await readFile(file, 'utf8')); receipt.inventory[0].path = '../auth.json';
  await writeFile(file, JSON.stringify(receipt));
  await assert.rejects(apply(request), errorCode('cleanup_receipt_invalid'));
  assert.equal(await readFile(path.join(f.root, 'auth.json'), 'utf8'), 'PRESERVE auth.json');
});


test('stopped parked barriers are inert checkpoints, while malformed or active barriers remain protected', async t => {
  const f = await fixture(t), value = journal();
  value.receipt.barrier = { controlId: 'control-one', expectedRevision: 4, kind: 'child_wait', barrierId: 'wait-one', generation: 1, acknowledgedSequence: 3 };
  await f.put('worker-service/runs/run-1.json', value);
  assert.equal((await plan(f.options)).summary.parkedCheckpoints, 1);
  await apply(await approved(f));
});

test('plans summarize historical unknown outcomes; deletion requires separate exact-inventory acknowledgement', async t => {
  const f = await fixture(t), value = journal();
  value.receipt.state = 'completed'; value.receipt.updatedAt = '2026-11-05T12:00:00Z';
  value.receipt.effects = { 'PRIVATE EFFECT ID': 'unknown', another: 'started' };
  await f.put('worker-service/runs/run-1.json', value);
  const result = await plan(f.options);
  assert.equal(result.requiresUnknownEffectsAcknowledgement, true);
  assert.deepEqual(result.summary.historicalEffects, { receipts: 1, unknown: 1, started: 1, earliestUpdatedAt: '2026-11-05T12:00:00.000Z', latestUpdatedAt: '2026-11-05T12:00:00.000Z' });
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  const request = { ...f.options, planDigest: result.digest, requestId: randomUUID(), confirmDelete: true };
  await assert.rejects(apply(request), errorCode('unknown_effects_acknowledgement_required'));
  assert.deepEqual(JSON.parse(await readFile(path.join(f.root, 'worker-service/runs/run-1.json'), 'utf8')).receipt.effects, value.receipt.effects);
  await assert.rejects(stat(path.join(f.root, '.legacy-harness-history-cleanup.json')), errorCode('ENOENT'));
  assert.equal((await apply({ ...request, acknowledgeUnknownEffects: true })).state, 'completed');
});

test('acknowledgement cannot bypass stop, callback, malformed effect or parked-effect safeguards', async t => {
  const f = await fixture(t), value = journal(); value.receipt.state = 'completed';
  value.receipt.updatedAt = '2026-11-10T14:00:00Z'; value.receipt.effects = { a: 'unknown' };
  await f.put('worker-service/runs/run-1.json', value); const request = await approved(f, { acknowledgeUnknownEffects: true });
  value.receipt.exitConfirmed = false; await f.put('worker-service/runs/run-1.json', value);
  await assert.rejects(apply(request), errorCode('worker_execution_unsettled'));
  value.receipt.exitConfirmed = true; value.receipt.state = 'parked'; await f.put('worker-service/runs/run-1.json', value);
  await assert.rejects(plan(f.options), errorCode('worker_effects_invalid'));
  value.receipt.state = 'cancelled'; value.receipt.effects = { a: 'unrecognized' }; await f.put('worker-service/runs/run-1.json', value);
  await assert.rejects(plan(f.options), errorCode('worker_effects_invalid'));
});
