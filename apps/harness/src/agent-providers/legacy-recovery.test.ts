import { afterEach, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { acquireStorageOwner } from "../storage-owner.js";
import { openProviderStore } from "./cutover.js";
import { createLegacyExitVerifier } from "./legacy-recovery.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2) + "\n");
}

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "hosty-harness-legacy-recovery-")));
  roots.push(root);
  const dataDir = path.join(root, "harness", "data");
  const provider = {
    appId: "independent.example", installationId: "2026-11-20T08:30:15.1234000+00:00", key: "default",
  };
  const providerRoot = path.join(root, provider.appId);
  const providerData = path.join(providerRoot, "data");
  const selection = { provider };
  const owner = "legacy-owner";
  const conversation = randomUUID();
  const providerSession = randomUUID();
  const nativeSession = randomUUID();
  const observationId = randomUUID();
  const providerRun = randomUUID();
  const providerGeneration = randomUUID();
  const nonce = randomUUID();
  const observedAt = new Date().toISOString();
  const archivedRecord = path.join(dataDir, "diagnostic-quarantine", "recovery", conversation, "record.json");
  const evidence = path.join(dataDir, "provider-cutover-evidence.json");
  const observations = path.join(dataDir, "agent-observations.json");
  const providerState = path.join(providerRoot, "state.json");
  const journal = path.join(providerData, "execution-journal", providerRun + ".json");
  const native = path.join(providerData, "native-processes", providerRun, providerGeneration);
  const manifest = path.join(native, "manifest.json");
  const processReceipt = path.join(native, nonce + ".json");
  const marker = path.join(dataDir, "execution-v2", "agent-consumer-format.json");
  const journalReceipt = {
    runId: providerRun, conversationId: providerSession, generation: randomUUID(),
    state: "completed", exitConfirmed: true, pending: [],
  };
  const stoppedProcess = {
    version: 1, runId: providerRun, generation: providerGeneration, nonce, state: "stopped", treeStopped: true,
    ...(process.platform === "win32" ? { mechanism: "windows-job.1", activeProcesses: 0, knownHandlesClosed: true } : {}),
  };

  await writeJson(path.join(dataDir, "agent-consumer-format.json"), { version: 1 });
  await writeJson(observations, {
    sessions: [{
      id: nativeSession, owner, conversation, revision: "1",
      binding: createHash("sha256").update(JSON.stringify([conversation, owner, "agent", null, null, providerSession])).digest("hex"),
    }],
    runs: [{
      id: observationId, owner, conversation, nativeSession, revision: "5", state: "failed",
      observedAt, stopConfirmed: false, generation: randomUUID(),
    }],
    cancellations: [{ key: "a".repeat(64), fingerprint: "b".repeat(64), runId: observationId, state: "pending" }],
  });
  await writeJson(archivedRecord, {
    id: conversation, createdBy: owner, status: "failed", harnessKind: "agent",
    agentRunId: observationId, providerObservedRunId: providerRun, harnessSessionId: providerSession, selection,
    providerExecution: {
      version: 1, selection, runId: providerRun, sessionId: providerSession,
      run: {
        ref: { id: providerRun, provider }, generation: providerGeneration, sessionId: providerSession,
        state: "unknown", phase: "interrupted", stopConfirmed: false,
      },
    },
  });
  await writeJson(providerState, { app: { id: provider.appId, installedAt: "2026-11-20T08:30:15.1234+00:00" } });
  await writeJson(journal, { version: 1, receipt: journalReceipt });
  await writeJson(manifest, {
    version: 1, runId: providerRun, generation: providerGeneration, spawns: [nonce],
    producerPid: process.pid, producerNonce: randomUUID(), sealed: true, sdkStopConfirmed: true,
  });
  await writeJson(processReceipt, stoppedProcess);
  await writeJson(evidence, { version: 1, records: [{ archivedRecord, providerRoot }] });

  return {
    dataDir, evidence, observations, archivedRecord, providerState, journal, manifest, processReceipt, marker,
    observationId, provider, providerRoot, providerSession, providerRun, providerGeneration, journalReceipt, stoppedProcess,
    open: async () => openProviderStore(dataDir, null, await createLegacyExitVerifier(dataDir, evidence)),
  };
}

it("verifies an exact archived provider exit and preserves its pending cancellation and source evidence", async () => {
  const f = await fixture();
  const legacyFiles = [f.observations, f.archivedRecord, f.journal, f.manifest, f.processReceipt, f.evidence];
  const before = await Promise.all(legacyFiles.map(file => readFile(file)));

  const store = await f.open();

  expect(store.dataDir).toBe(path.join(f.dataDir, "execution-v2"));
  expect(await store.listRecords()).toEqual([]);
  expect(JSON.parse(await readFile(f.marker, "utf8"))).toEqual({ version: 2 });
  expect(await Promise.all(legacyFiles.map(file => readFile(file)))).toEqual(before);
});

it.each(["record", "sidecar"] as const)("accepts an exact legacy cancellation retained in the %s", async location => {
  const f = await fixture();
  const record = JSON.parse(await readFile(f.archivedRecord, "utf8"));
  const sidecar = path.join(path.dirname(f.archivedRecord), "provider-execution.json");
  const cancelBody = JSON.stringify({ requestId: randomUUID(), expectedGeneration: f.providerGeneration });
  const cancelling = {
    ...record.providerExecution,
    mutations: { cancel: {
      operation: "runs.cancel", method: "POST", path: "/runs/" + f.providerRun + "/cancel",
      runId: f.providerRun, body: cancelBody, bodyHash: createHash("sha256").update(cancelBody).digest("hex"),
    } },
  };
  if (location === "record") {
    await writeJson(sidecar, record.providerExecution);
    await writeJson(f.archivedRecord, { ...record, providerExecution: cancelling });
  } else {
    await writeJson(sidecar, cancelling);
  }
  const sourceFiles = [f.archivedRecord, sidecar, f.observations];
  const before = await Promise.all(sourceFiles.map(file => readFile(file)));

  await f.open();

  expect(JSON.parse(await readFile(f.marker, "utf8"))).toEqual({ version: 2 });
  expect(await Promise.all(sourceFiles.map(file => readFile(file)))).toEqual(before);
});

async function archiveContinuation(f: Awaited<ReturnType<typeof fixture>>, state: string,
  runId = f.providerRun, provider = f.provider) {
  const record = JSON.parse(await readFile(f.archivedRecord, "utf8"));
  const sourceRunId = randomUUID(), requestId = randomUUID();
  const providerExecution = {
    ...record.providerExecution,
    continuations: { [JSON.stringify([sourceRunId, requestId])]: {
      requestId, sourceRunId, state, run: { id: runId, provider },
      input: { expectedSessionRevision: "1", configurationRevision: "1", continuation: "start", input: { text: "Start" } },
    } },
  };
  const sidecar = path.join(path.dirname(f.archivedRecord), "provider-execution.json");
  await writeJson(f.archivedRecord, { ...record, providerExecution });
  await writeJson(sidecar, providerExecution);
  return sidecar;
}

it("accepts an admitted continuation for the exact resumed run with a verified exit", async () => {
  const f = await fixture();
  const sidecar = await archiveContinuation(f, "admitted");
  const sourceFiles = [f.archivedRecord, sidecar, f.observations, f.journal, f.processReceipt];
  const before = await Promise.all(sourceFiles.map(file => readFile(file)));

  await f.open();

  expect(JSON.parse(await readFile(f.marker, "utf8"))).toEqual({ version: 2 });
  expect(await Promise.all(sourceFiles.map(file => readFile(file)))).toEqual(before);
});

it.each([
  "admitted for a different run", "admitted for a different provider", "awaiting authorization", "pending",
] as const)("rejects an archived continuation that is %s", async issue => {
  const f = await fixture();
  if (issue === "admitted for a different run") {
    await archiveContinuation(f, "admitted", randomUUID());
  } else if (issue === "admitted for a different provider") {
    await archiveContinuation(f, "admitted", f.providerRun, { ...f.provider, key: "other-provider" });
  } else {
    await archiveContinuation(f, issue === "pending" ? "pending" : "awaiting_authorization");
  }

  await expect(f.open()).rejects.toThrow(f.observationId);

  await expect(readFile(f.marker)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["different run", "pending start", "source admission", "missing selected sidecar"] as const)(
  "rejects a verified archive that retains %s",
  async issue => {
    const f = await fixture();
    const record = JSON.parse(await readFile(f.archivedRecord, "utf8"));
    const sidecar = path.join(path.dirname(f.archivedRecord), "provider-execution.json");
    const nextRun = randomUUID();
    if (issue === "different run") {
      await writeJson(sidecar, {
        ...record.providerExecution, runId: nextRun,
        run: { ...record.providerExecution.run, ref: { id: nextRun, provider: f.provider } },
      });
    } else if (issue === "pending start") {
      await writeJson(sidecar, {
        ...record.providerExecution,
        mutations: { start: {
          operation: "runs.start", method: "PUT", path: "/sessions/" + f.providerSession + "/runs/" + nextRun,
          sessionId: f.providerSession, runId: nextRun,
        } },
      });
    } else if (issue === "source admission") {
      await writeJson(f.archivedRecord, { ...record, sourceAdmission: { runId: nextRun, state: "dispatching" } });
    } else {
      const contextId = randomUUID();
      await writeJson(sidecar, record.providerExecution);
      await writeJson(f.archivedRecord, {
        ...record, contextChanges: [{ requestId: contextId }],
        providerExecution: { ...record.providerExecution, contextId },
      });
    }
    const before = await readFile(f.observations);

    await expect(f.open()).rejects.toThrow(f.observationId);

    await expect(readFile(f.marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(f.observations)).toEqual(before);
  },
);

it.each(["provider installation", "process generation", "provider session"] as const)(
  "blocks an archived run whose exit evidence has a different %s",
  async difference => {
    const f = await fixture();
    if (difference === "provider installation")
      await writeJson(f.providerState, { app: { id: f.provider.appId, installedAt: "2026-11-20T08:30:15.1234001+00:00" } });
    if (difference === "process generation")
      await writeJson(f.processReceipt, { ...f.stoppedProcess, generation: randomUUID() });
    if (difference === "provider session")
      await writeJson(f.journal, { version: 1, receipt: { ...f.journalReceipt, conversationId: randomUUID() } });
    const before = await readFile(f.observations);

    await expect(f.open()).rejects.toThrow(f.observationId);

    await expect(readFile(f.marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(f.observations)).toEqual(before);
  },
);


async function reinstallProvider(f: Awaited<ReturnType<typeof fixture>>, mismatch?: "installation" | "generation") {
  const installedAt = "2026-11-21T08:44:31.3113680+00:00";
  const snapshotProvider = mismatch === "installation" ? { ...f.provider, installationId: installedAt } : f.provider;
  const archivedProviderSession = path.join(f.providerRoot, "data", "diagnostic-quarantine", "recovery", f.providerSession + ".json");
  await writeJson(f.providerState, { app: { id: f.provider.appId, installedAt } });
  await writeJson(archivedProviderSession, {
    version: 1,
    id: f.providerSession,
    session: { ref: { id: f.providerSession, provider: snapshotProvider } },
    runs: {
      [f.providerRun]: {
        nativeGeneration: f.journalReceipt.generation,
        snapshot: {
          ref: { id: f.providerRun, provider: snapshotProvider },
          generation: mismatch === "generation" ? randomUUID() : f.providerGeneration,
          sessionId: f.providerSession,
        },
        controls: {},
      },
    },
  });
  await writeJson(f.evidence, {
    version: 1, records: [{ archivedRecord: f.archivedRecord, providerRoot: f.providerRoot, archivedProviderSession }],
  });
  return archivedProviderSession;
}

it("uses an exact archive from the original provider installation after reinstall", async () => {
  const f = await fixture();
  const archivedProviderSession = await reinstallProvider(f);
  const before = await readFile(archivedProviderSession);

  const store = await f.open();

  expect(store.dataDir).toBe(path.join(f.dataDir, "execution-v2"));
  expect(await store.listRecords()).toEqual([]);
  expect(JSON.parse(await readFile(f.marker, "utf8"))).toEqual({ version: 2 });
  expect(await readFile(archivedProviderSession)).toEqual(before);
});

it.each(["installation", "generation"] as const)(
  "rejects a reinstalled provider archive with the wrong original %s",
  async mismatch => {
    const f = await fixture();
    const archivedProviderSession = await reinstallProvider(f, mismatch);
    const before = await readFile(archivedProviderSession);

    await expect(f.open()).rejects.toThrow(f.observationId);

    await expect(readFile(f.marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(archivedProviderSession)).toEqual(before);
  },
);

it("blocks a verified provider exit whose native session binding belongs to another conversation", async () => {
  const f = await fixture();
  const observations = JSON.parse(await readFile(f.observations, "utf8"));
  observations.sessions[0].binding = "f".repeat(64);
  await writeJson(f.observations, observations);

  await expect(f.open()).rejects.toThrow(f.observationId);

  await expect(readFile(f.marker)).rejects.toMatchObject({ code: "ENOENT" });
});


it("runs the offline recovery command only when it can acquire the Harness writer lock", async () => {
  const f = await fixture();
  const entrypoint = fileURLToPath(new URL("../recover-legacy-cutover.ts", import.meta.url));
  const run = () => promisify(execFile)(process.execPath, [
    "--import", "tsx", entrypoint, "--data-dir", f.dataDir, "--evidence", f.evidence,
  ], { timeout: 5000 });
  const release = await acquireStorageOwner(f.dataDir, "coordinator");

  try {
    await expect(run()).rejects.toMatchObject({ stderr: expect.stringContaining("The Harness storage writer is already active") });
    await expect(readFile(f.marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    release();
  }

  await expect(run()).resolves.toMatchObject({ stdout: expect.stringContaining("Harness v2 execution store is ready") });
  expect(JSON.parse(await readFile(f.marker, "utf8"))).toEqual({ version: 2 });
}, 10_000);
