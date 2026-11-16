#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, readdir, realpath, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const TARGETS = ['provider-sessions', 'worker-service/provider-sessions', 'worker-service/runs', 'agent-observations.json'];
const RECEIPT = '.legacy-harness-history-cleanup.json';
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'parked']);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const empty = value => value === undefined || value === null || object(value) && Object.keys(value).length === 0;
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
const issue = (code, message) => { throw Object.assign(new Error(message), { code, cleanupError: true }); };
const absent = error => error?.code === 'ENOENT';
const safeIdentity = value => typeof value === 'string' && /^[A-Za-z0-9-]{1,100}$/.test(value);
function validBarrier(value) {
  return object(value) && Object.keys(value).every(key => ['controlId', 'expectedRevision', 'kind', 'barrierId', 'generation', 'acknowledgedSequence', 'origin'].includes(key))
    && safeIdentity(value.controlId) && safeIdentity(value.barrierId)
    && Number.isSafeInteger(value.expectedRevision) && value.expectedRevision >= 0
    && Number.isSafeInteger(value.generation) && value.generation >= 1
    && [undefined, 'coordinator'].includes(value.origin)
    && ['task_adoption', 'child_wait', 'source_rebind', 'limits', 'human_input'].includes(value.kind)
    && (value.origin !== 'coordinator' || ['source_rebind', 'limits'].includes(value.kind))
    && Number.isSafeInteger(value.acknowledgedSequence) && value.acknowledgedSequence >= (value.origin === 'coordinator' ? 0 : 1);
}

async function info(file) {
  const value = await lstat(file).catch(error => { if (absent(error)) return null; throw error; });
  if (value?.isSymbolicLink() || value?.isFile() && value.nlink !== 1)
    issue('unsafe_history_path', 'History and ownership paths must not be linked to another location.');
  return value;
}
async function safePath(root, relative, required = false) {
  let current = root;
  const parts = relative.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const value = await info(current);
    if (!value) { if (required) issue('legacy_layout_missing', 'The expected legacy Harness ownership layout is missing.'); return null; }
    if (i !== parts.length - 1 && !value.isDirectory()) issue('unsafe_history_path', 'A history parent is not an ordinary directory.');
  }
  return current;
}
async function metadata(file, max = 256 * 1024 * 1024) {
  const value = await info(file);
  if (!value?.isFile() || value.size > max) issue('metadata_unavailable', 'Legacy execution metadata is not a bounded ordinary file.');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { return JSON.parse(await handle.readFile('utf8')); }
  catch { issue('metadata_unavailable', 'Legacy execution metadata is unreadable; preserve it for recovery.'); }
  finally { await handle.close(); }
}
async function shaFile(file) {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { const hash = createHash('sha256'); for await (const bytes of handle.createReadStream({ autoClose: false })) hash.update(bytes); return hash.digest('hex'); }
  finally { await handle.close(); }
}
async function withOwners(dataDir, action) {
  if (!path.isAbsolute(dataDir)) issue('data_root_required', 'Supply an explicit absolute Harness app data directory.');
  const root = path.resolve(dataDir);
  if (root === path.parse(root).root || await realpath(root) !== root || !(await info(root))?.isDirectory())
    issue('unsafe_data_root', 'Use the real, ordinary Harness app data directory.');
  const locks = [];
  try {
    for (const name of ['coordinator-owner.sqlite', 'worker-service/worker-owner.sqlite']) {
      const file = await safePath(root, name, true);
      if (!(await info(file))?.isFile()) issue('legacy_layout_missing', 'The legacy Harness ownership files are required.');
      let database;
      try { database = new DatabaseSync(file); database.exec('PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;'); }
      catch { database?.close(); issue('storage_in_use', 'Stop both legacy Harness services through Core before cleanup; their exclusive ownership must be available.'); }
      locks.push(database);
    }
    return await action(root);
  } finally { for (const database of locks.reverse()) database.close(); }
}
function checkOwner(owner) {
  if (typeof owner !== 'string' || !owner || owner.length > 512 || /[\u0000-\u001f\u007f]/.test(owner))
    issue('owner_required', 'Supply the exact reviewed legacy observation owner ID.');
}
async function readReceipt(root) {
  const file = await safePath(root, RECEIPT);
  if (!file) return null;
  const value = await metadata(file);
  if (!object(value) || value.version !== 1 || !uuid(value.requestId) || !['pending', 'completed'].includes(value.state)
      || !Array.isArray(value.inventory) || !Array.isArray(value.targets) || value.root !== root || typeof value.owner !== 'string'
      || !/^[a-f0-9]{64}$/.test(value.digest)) issue('cleanup_receipt_invalid', 'Recover the retained cleanup receipt before another operation.');
  const paths = new Set();
  for (const entry of value.inventory) {
    if (!object(entry) || typeof entry.path !== 'string' || paths.has(entry.path)
        || !TARGETS.some(target => entry.path === target || target !== 'agent-observations.json' && entry.path.startsWith(target + '/'))
        || entry.path.split('/').some(part => !part || part === '.' || part === '..' || part.includes('\\'))
        || !['directory', 'file'].includes(entry.type)
        || entry.type === 'file' && (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/.test(entry.hash)))
      issue('cleanup_receipt_invalid', 'Recover the retained cleanup receipt before another operation.');
    paths.add(entry.path);
  }
  if (value.digest !== digest({ version: 1, root, owner: value.owner, inventory: value.inventory }))
    issue('cleanup_receipt_invalid', 'The retained cleanup inventory no longer matches its approved digest.');
  return value;
}
async function writeReceipt(root, value) {
  const target = path.join(root, RECEIPT), temporary = target + '.' + randomUUID() + '.tmp';
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, target);
    if (process.platform !== 'win32') { const directory = await open(root, 'r'); try { await directory.sync(); } finally { await directory.close(); } }
  } finally { await rm(temporary, { force: true }); }
}
async function inspect(root, owner) {
  checkOwner(owner);
  if (await safePath(root, 'agent-consumer-format.json')) issue('already_cut_over', 'The provider consumer format already exists; this helper is only for the one-time legacy cutover.');
  const sessions = await safePath(root, 'sessions');
  if (sessions && (!(await info(sessions)).isDirectory() || (await readdir(sessions)).length))
    issue('conversations_remain', 'The global Harness conversation directory must be empty; use supported conversation controls first.');
  const summary = { observations: 0, observedRuns: 0, retiredPendingCancellations: 0, workerRuns: 0, unappliedControls: 0,
    parkedCheckpoints: 0, historicalEffects: { receipts: 0, started: 0, unknown: 0, earliestUpdatedAt: null, latestUpdatedAt: null } };
  const observationFile = await safePath(root, 'agent-observations.json');
  if (observationFile) {
    const value = await metadata(observationFile, 64 * 1024 * 1024);
    if (!object(value) || !Array.isArray(value.sessions) || !Array.isArray(value.runs) || !Array.isArray(value.cancellations))
      issue('observations_invalid', 'Legacy observation metadata has an unknown shape.');
    const runs = new Map();
    for (const run of value.runs) {
      if (!object(run) || typeof run.id !== 'string' || runs.has(run.id) || run.owner !== owner || run.conversation !== null || run.stopConfirmed !== true)
        issue('observed_execution_unsettled', 'Every legacy observation must belong to the selected owner, be orphaned and have confirmed exit.');
      runs.set(run.id, run);
    }
    for (const session of value.sessions)
      if (!object(session) || typeof session.id !== 'string' || session.owner !== owner || session.conversation !== null)
        issue('observations_invalid', 'Every legacy native-session observation must be orphaned and belong to the selected owner.');
    for (const receipt of value.cancellations) {
      const run = object(receipt) ? runs.get(receipt.runId) : null;
      if (!run || !['pending', 'completed', 'rejected'].includes(receipt.state))
        issue('cancellation_unsettled', 'A legacy cancellation lacks its confirmed, orphaned run.');
      if (receipt.state === 'pending') summary.retiredPendingCancellations++;
    }
    summary.observations = value.sessions.length; summary.observedRuns = value.runs.length;
  }
  const journal = await safePath(root, 'worker-service/runs');
  if (journal) {
    if (!(await info(journal)).isDirectory()) issue('worker_journal_invalid', 'The legacy worker journal is not an ordinary directory.');
    for (const name of (await readdir(journal)).sort()) {
      if (!/^[A-Za-z0-9-]{1,100}\.json$/.test(name)) issue('worker_journal_invalid', 'Unknown worker journal entries require recovery before cleanup.');
      const value = await metadata(path.join(journal, name)), receipt = value?.receipt;
      if (!object(value) || value.version !== 1 || !object(receipt) || receipt.runId !== name.slice(0, -5)
          || !terminal.has(receipt.state) || receipt.exitConfirmed !== true
          || receipt.pending !== undefined && (!Array.isArray(receipt.pending) || receipt.pending.length)
          || !Array.isArray(value.events) || !object(value.controls))
        issue('worker_execution_unsettled', 'Every worker journal must have terminal, confirmed exit with no pending callbacks.');
      if (!empty(receipt.effects)) {
        if (!object(receipt.effects) || Object.values(receipt.effects).some(state => !['started', 'unknown'].includes(state))
            || receipt.state === 'parked')
          issue('worker_effects_invalid', 'Historical effect metadata has an unknown or inconsistent shape.');
        const updatedAt = typeof receipt.updatedAt === 'string' && Date.parse(receipt.updatedAt);
        if (!Number.isFinite(updatedAt)) issue('worker_effects_invalid', 'Historical effect timestamps require review before cleanup.');
        const effects = summary.historicalEffects, time = new Date(updatedAt).toISOString(); effects.receipts++;
        for (const state of Object.values(receipt.effects)) effects[state]++;
        if (effects.earliestUpdatedAt === null || time < effects.earliestUpdatedAt) effects.earliestUpdatedAt = time;
        if (effects.latestUpdatedAt === null || time > effects.latestUpdatedAt) effects.latestUpdatedAt = time;
      }
      if (!empty(receipt.barrier)) {
        if (receipt.state !== 'parked' || !empty(receipt.effects) || !validBarrier(receipt.barrier))
          issue('worker_barrier_invalid', 'Only a schema-valid, stopped parked checkpoint may be discarded.');
        summary.parkedCheckpoints++;
      }
      for (const control of Object.values(value.controls)) {
        if (!object(control) || !/^[a-f0-9]{64}$/.test(control.hash) || typeof control.applied !== 'boolean')
          issue('worker_controls_invalid', 'A worker control receipt has an unknown shape.');
        if (!control.applied) { summary.unappliedControls++; issue('worker_controls_unsettled', 'An unapplied worker control must be reconciled before deleting its replay evidence.'); }
      }
      summary.workerRuns++;
    }
  }
  for (const relative of TARGETS.slice(0, 2)) {
    const native = await safePath(root, relative); if (!native) continue;
    if (!(await info(native)).isDirectory()) issue('native_layout_invalid', 'The legacy native history root must be an ordinary directory.');
    for (const connection of await readdir(native)) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(connection)) issue('native_layout_invalid', 'Unknown legacy connection history layout.');
      const account = path.join(native, connection); if (!(await info(account))?.isDirectory()) issue('native_layout_invalid', 'Unknown legacy connection history layout.');
      for (const revision of await readdir(account)) {
        const revisionDir = path.join(account, revision);
        if (!/^[1-9][0-9]{0,38}$/.test(revision) || !(await info(revisionDir))?.isDirectory()) issue('native_layout_invalid', 'Unknown legacy connection revision history layout.');
        for (const kind of await readdir(revisionDir))
          if (!['sessions', 'archived_sessions', 'projects', 'ollama'].includes(kind) || !(await info(path.join(revisionDir, kind)))?.isDirectory())
            issue('native_layout_invalid', 'Only the documented native conversation directories may be removed.');
      }
    }
  }
  const inventory = [], targets = []; let totalBytes = 0;
  async function walk(relative, depth = 0) {
    if (depth > 32 || inventory.length >= 200000) issue('history_budget', 'Legacy history inventory exceeds the bounded cleanup budget.');
    const file = await safePath(root, relative), value = file && await info(file); if (!value) return;
    if (value.isDirectory()) {
      inventory.push({ path: relative, type: 'directory' });
      for (const child of (await readdir(file)).sort()) await walk(relative + '/' + child, depth + 1);
    } else if (value.isFile()) {
      totalBytes += value.size; if (totalBytes > 16 * 1024 ** 3) issue('history_budget', 'Legacy history exceeds the bounded cleanup byte budget.');
      inventory.push({ path: relative, type: 'file', bytes: value.size, hash: await shaFile(file) });
    } else issue('unsafe_history_path', 'Only ordinary history files and directories may be removed.');
  }
  for (const relative of TARGETS) {
    const before = inventory.length; await walk(relative);
    const entries = inventory.slice(before);
    targets.push({ path: relative, files: entries.filter(e => e.type === 'file').length, bytes: entries.reduce((sum, e) => sum + (e.bytes ?? 0), 0), exists: entries.length > 0 });
  }
  inventory.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { version: 1, root, owner, targets, summary, requiresUnknownEffectsAcknowledgement: summary.historicalEffects.receipts > 0, inventory, digest: digest({ version: 1, root, owner, inventory }) };
}
function publicPlan(plan) { const { inventory, ...value } = plan; return value; }
export async function planLegacyHarnessHistory({ dataDir, owner }) {
  return withOwners(dataDir, async root => {
    const receipt = await readReceipt(root);
    if (receipt?.state === 'pending') issue('cleanup_pending', 'Resume the retained cleanup request UUID and plan digest.');
    return publicPlan(await inspect(root, owner));
  });
}
export async function applyLegacyHarnessHistory({ dataDir, owner, planDigest, requestId, confirmDelete, acknowledgeUnknownEffects = false }) {
  checkOwner(owner);
  if (!confirmDelete || !uuid(requestId) || !/^[a-f0-9]{64}$/.test(planDigest ?? '')) issue('confirmation_required', 'Apply requires the exact plan digest, a stable request UUID and explicit history deletion confirmation.');
  return withOwners(dataDir, async root => {
    let receipt = await readReceipt(root);
    if (receipt && receipt.requestId === requestId) {
      if (receipt.digest !== planDigest || receipt.owner !== owner) issue('request_conflict', 'Recover the same cleanup request with unchanged owner and plan digest.');
      if (receipt.state === 'completed') return { requestId, state: 'completed', replay: true, targets: receipt.targets };
    } else if (receipt?.state === 'pending') issue('cleanup_pending', 'Resume the original pending cleanup request.');
    const current = await inspect(root, owner);
    if ((current.requiresUnknownEffectsAcknowledgement || receipt?.requestId === requestId && receipt.requiresUnknownEffectsAcknowledgement)
        && acknowledgeUnknownEffects !== true)
      issue('unknown_effects_acknowledgement_required', 'The exact reviewed history includes unknown external outcomes. Explicitly acknowledge their history deletion; cleanup does not settle or reverse those effects.');
    if (receipt?.requestId === requestId) {
      const original = new Map(receipt.inventory.map(entry => [entry.path, entry]));
      if (current.inventory.some(entry => JSON.stringify(entry) !== JSON.stringify(original.get(entry.path))))
        issue('history_changed', 'History changed outside the retained cleanup scope; preserve it and inspect recovery.');
    } else {
      if (current.digest !== planDigest) issue('plan_changed', 'History changed after review. Prepare and approve a fresh plan before deletion.');
      receipt = { ...current, requestId, acknowledgedUnknownEffects: acknowledgeUnknownEffects === true, state: 'pending' }; await writeReceipt(root, receipt);
    }
    try {
      for (const relative of TARGETS) {
        const file = await safePath(root, relative); if (!file) continue;
        await rm(file, { recursive: true });
        if (process.platform !== 'win32') {
          const parent = await open(path.dirname(file), 'r');
          try { await parent.sync(); } finally { await parent.close(); }
        }
      }
      receipt.state = 'completed'; await writeReceipt(root, receipt);
    } catch (error) {
      if (error?.code?.startsWith('unsafe_')) throw error;
      issue('cleanup_partial', 'Cleanup stopped with a retained pending receipt. Keep services stopped and resume the same request.');
    }
    return { requestId, state: 'completed', replay: false, targets: receipt.targets };
  });
}
async function main(args) {
  const [command, ...rest] = args, options = {};
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    if (key === '--confirm-delete-legacy-history') options.confirmDelete = true;
    else if (key === '--acknowledge-unknown-effects') options.acknowledgeUnknownEffects = true;
    else if (['--data-dir', '--owner', '--plan-digest', '--request-id'].includes(key) && rest[i + 1]) {
      options[{ '--data-dir': 'dataDir', '--owner': 'owner', '--plan-digest': 'planDigest', '--request-id': 'requestId' }[key]] = rest[++i];
    } else issue('usage', 'Use plan --data-dir <absolute> --owner <id>, or apply with --plan-digest <sha256> --request-id <UUID> --confirm-delete-legacy-history.');
  }
  if (!options.dataDir || !['plan', 'apply'].includes(command)) issue('usage', 'Choose plan or apply and supply the exact absolute Harness app data directory.');
  const result = command === 'plan' ? await planLegacyHarnessHistory(options) : await applyLegacyHarnessHistory(options);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch(error => { process.stderr.write(JSON.stringify({ error: { code: error.code ?? 'cleanup_failed', message: error.cleanupError ? error.message : 'Cleanup failed; preserve the retained data and inspect recovery.' } }) + '\n'); process.exitCode = 1; });
