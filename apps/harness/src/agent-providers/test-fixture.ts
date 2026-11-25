import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AGENT_CAPABILITIES, AGENT_SESSION_WORKFLOW_TOOLS, type AgentAuthorizationRequest, type AgentCapabilities, type AgentConfiguration, type AgentControlReceipt, type AgentEvent, type AgentRunInput,
  type AgentRunSnapshot, type AgentSession, type AgentSource } from "@hosty-sdk/app/agent";
import { AuditReporter } from "../audit.js";
import type { HarnessAdapter } from "../harness/adapter.js";
import { SessionManager } from "../sessions/manager.js";
import { SessionStore } from "../sessions/store.js";
import type { DevelopmentClient } from "../sessions/development.js";
import type { SettingsStore } from "../settings/store.js";
import type { ProfileStore } from "../profiles/store.js";
import type { ProviderDirectory } from "../settings/providers.js";
import { AgentConsumerConnections } from "./connections.js";
import { CoreAgentBackend } from "./core.js";
import { AgentConnectionDirectory, agentSelectionId } from "./directory.js";

/** Test-only public HTTP/SSE peer. It contains no engine, worker transport or provider credentials. */
export async function publicProviderFixture(installationHistory = false, implementationId?: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hosty-public-provider-"));
  const provider = { appId: "independent.example", installationId: "installation-one", key: "coding", ...(implementationId ? { implementationId } : {}) };
  const selection = { provider, connection: { id: "account", revision: "1" } };
  const connectionId = agentSelectionId(selection), owner = "operator", credential = "test-owner-authority";
  const capabilities: AgentCapabilities = { version: 2, eventVersions: ["agent-event.1"],
    capabilities: ["session.resume", "configuration.resume-compatible", "decisions.questions", "runs.barrier", "runs.park", "runs.reconcile", AGENT_CAPABILITIES.retire, AGENT_CAPABILITIES.consumerWorkflow],
    limits: { maxCommandBytes: 1048576, maxEventBytes: 1048576, maxSnapshotBytes: 1048576, maxReplayBytes: 4194304,
      replayRetentionMs: 86400000, maxControls: 100, maxPageSize: 100 }, configuration: { resumeCompatible: [] } };
  if (installationHistory) capabilities.capabilities.push("installation-history");
  const sessions = new Map<string, AgentSession>(), runs = new Map<string, AgentRunSnapshot>();
  const events = new Map<string, AgentEvent[]>(), receipts = new Map<string, AgentControlReceipt>();
  const watchers = new Map<string, Set<ReadableStreamDefaultController<Uint8Array>>>();
  const requests: Array<{ method: string; path: string; body: string; accept: string | null; authorization: string | null; userToken: string | null }> = [];
  const authorizations: AgentAuthorizationRequest[] = [];
  const runOwners = new Map<string, string>();
  const history: Uint8Array[] = [], historyStreams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  let denyHistory = false, expireHistoricalCursor = false;
  const historyPositions = new Map<string, number>();
  const publishHistory = (sessionId: string, runId: string, userId: string, item: import("@hosty-sdk/app/agent").AgentWatchItem) => {
    if (!installationHistory) return;
    const generation = item.kind === "event" ? item.event.generation : item.snapshot.generation;
    const sessionPosition = (historyPositions.get(sessionId) ?? 0) + 1;
    historyPositions.set(sessionId, sessionPosition);
    const value = JSON.stringify({ sessionId, runId, userId, principalId: userId, generation, item, sessionPosition, epoch: "fixture-" + sessionId });
    const frame = new TextEncoder().encode(`event: observation\nid: feed-${history.length + 1}\ndata: ${value}\n\n`);
    history.push(frame);
    for (const stream of historyStreams) stream.enqueue(frame);
  };
  const starts: Array<{ runId: string; sessionId: string; input: AgentRunInput; body: string }> = [];
  const refusedStarts = new Map<string, { sessionId: string; body: string }>();
  const controls: Array<{ runId: string; input: Record<string, unknown>; path: string }> = [];
  const managers: SessionManager[] = [];
  const behavior: { startGate?: Promise<void>; cancel: "confirmed" | "unavailable" | "unresolved"; reconcile: "confirmed" | "unavailable";
    retire?: "confirmed" | "unavailable"; loseNextRetireResponse?: boolean;
    loseNextResponse?: boolean; revokeReplay?: boolean;
    sessionLookupGate?: Promise<void>; failSessionLookup?: boolean; failHistoryTokenOnce?: boolean; rejectHistoryStream?: boolean; legacyWorkflowCore?: boolean;
    legacyHistoryRoute?: boolean; capabilitiesTimeoutAfterStart?: boolean; snapshotIssue?: "denied" | "timeout";
    loseNextStartResponse?: boolean; refuseNextStart?: boolean; keepReservationAfterCancel?: boolean; deferPredictions?: boolean; beforeCancel?: (runId: string) => void;
    connectionRevision: string } = { cancel: "confirmed", reconcile: "confirmed", connectionRevision: "1" };
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const error = (code: string, message: string, status = 409) => json({ error: { code, message, retryable: false } }, status);
  const digest = (configuration: AgentConfiguration) => createHash("sha256").update(JSON.stringify(configuration)).digest("hex");
  const frame = (event: AgentEvent) => new TextEncoder().encode(`event: agent\nid: cursor-${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`);
  const emit = (runId: string, type: AgentEvent["type"], data: Record<string, unknown>, source: AgentSource = { agentId: "root" }): AgentEvent => {
    const snapshot = runs.get(runId)!;
    snapshot.lastSequence = String(BigInt(snapshot.lastSequence) + 1n); snapshot.cursor = `cursor-${snapshot.lastSequence}`;
    snapshot.observedAt = new Date().toISOString();
    const event: AgentEvent = { schemaVersion: "agent-event.1", runId, generation: snapshot.generation, revision: snapshot.revision,
      sequence: snapshot.lastSequence, source, occurredAt: snapshot.observedAt,
      type, data: type === "run.updated" ? { snapshot: structuredClone(snapshot) } : data };
    (events.get(runId) ?? []).push(event);
    for (const watcher of watchers.get(runId) ?? []) watcher.enqueue(frame(event));
    publishHistory(snapshot.sessionId, runId, runOwners.get(runId) ?? owner, { kind: "event", event, cursor: snapshot.cursor });
    return event;
  };
  const grants = new Map<string, { reference: string; request: AgentAuthorizationRequest }>();
  const admissionRefs = new Map<string, string>();
  const update = (runId: string, patch: Partial<AgentRunSnapshot>) => {
    const snapshot = runs.get(runId)!; Object.assign(snapshot, structuredClone(patch));
    snapshot.revision = String(BigInt(snapshot.revision) + 1n); emit(runId, "run.updated", {});
    if (snapshot.stopConfirmed) { const session = sessions.get(snapshot.sessionId)!; session.activeRun = null; session.nativeState = "available"; session.revision = String(BigInt(session.revision) + 1n); }
    return structuredClone(snapshot);
  };
  const fetcher: typeof fetch = async (input, init) => {
    init?.signal?.throwIfAborted();
    const url = new URL(input instanceof Request ? input.url : String(input)), method = init?.method ?? "GET";
    const body = String(init?.body ?? "");
    requests.push({ method, path: url.pathname + url.search, body, accept: new Headers(init?.headers).get("accept"), authorization: new Headers(init?.headers).get("authorization"),
      userToken: new Headers(init?.headers).get("X-Hosty-User-Token") });
    if (url.hostname === "core.test") {
      if (url.pathname.endsWith("/providers/agent")) return json({ providers: [{ ...provider, displayName: "Independent coding provider", available: true, version: 2 }] });
      if (url.pathname.endsWith("/agent/history/token")) {
        if (behavior.failHistoryTokenOnce) { delete behavior.failHistoryTokenOnce; return error("unavailable", "Core is restarting.", 503); }
        if (!installationHistory && !behavior.legacyHistoryRoute) return new Response(null, { status: 404 });
        if (denyHistory) return error("permission_denied", "Installation access was revoked.", 403);
        if (new Headers(init?.headers).has("X-Hosty-User-Token")) return error("unexpected_actor", "Expected installation authority.");
        return json({ endpoint: "http://provider.test/api/agent/v2/coding", token: "installation-read-only", expiresAt: new Date(Date.now() + 60000).toISOString() });
      }
      if (url.pathname.endsWith("/agent/replay/token")) {
        if (behavior.revokeReplay) return error("authority_expired", "The current grant is no longer available.", 403);
        const { admissionRef, provider: target, ...request } = JSON.parse(body);
        const grant = grants.get(JSON.stringify([request.method, request.path, request.bodyHash]));
        if (!grant || grant.reference !== admissionRef || grant.request.operation !== request.operation || grant.request.sessionId !== request.sessionId || grant.request.runId !== request.runId ||
          new Headers(init?.headers).has("X-Hosty-User-Token")) return error("permission_denied", "Wrong replay scope.", 403);
        return json({ provider: target, baseUrl: "http://provider.test/api/agent/v2/coding", token: "exact-operation-fixture", expiresAt: new Date(Date.now() + 60000).toISOString() });
      }
      if (url.pathname.endsWith("/agent/cleanup/token")) {
        const request = JSON.parse(body);
        if (!request.runId || admissionRefs.get(request.runId) !== request.admissionRef ||
          !["runs.read", "runs.cancel", "runs.controls.read", "runs.closure", "runs.discard"].includes(request.operation) ||
          new Headers(init?.headers).has("X-Hosty-User-Token")) return error("permission_denied", "Wrong cleanup scope.", 403);
        return json({ provider, baseUrl: "http://provider.test/api/agent/v2/coding", token: "exact-operation-fixture",
          expiresAt: new Date(Date.now() + 60000).toISOString() });
      }
      if (url.pathname.endsWith("/agent/authorize")) {
        const authorization = JSON.parse(body) as AgentAuthorizationRequest; authorizations.push(authorization);
        if (behavior.legacyWorkflowCore && authorization.ceiling?.workflow?.tools?.some(name =>
          !AGENT_SESSION_WORKFLOW_TOOLS.some(legacy => legacy === name)))
          return error("invalid_input", "Select only the legacy task workflow tool names.", 400);
        if (authorization.operation === "runs.start" && authorization.runId) {
          const actor = new Headers(init?.headers).get("X-Hosty-User-Token");
          if (!admissionRefs.has(authorization.runId)) admissionRefs.set(authorization.runId, randomUUID());
          runOwners.set(authorization.runId, actor === credential ? owner : actor?.replace(/^user:/, "") ?? owner);
        }
        const { provider: target, ...request } = JSON.parse(body);
        const key = JSON.stringify([request.method, request.path, request.bodyHash]);
        if (request.method !== "GET" && !grants.has(key)) grants.set(key, {
          request, reference: request.operation === "runs.start" ? admissionRefs.get(request.runId)! : randomUUID() });
        return json({ provider: target, baseUrl: "http://provider.test/api/agent/v2/coding", token: "exact-operation-fixture",
          expiresAt: new Date(Date.now() + 60000).toISOString(), admissionRef: grants.get(key)?.reference,
          ...(behavior.legacyWorkflowCore ? {} : { supportedWorkflowCapabilities: [AGENT_CAPABILITIES.sessionSubagents, AGENT_CAPABILITIES.profileManagement] }) });
      }
      return error("fixture_route", "Unexpected Core fixture route.", 404);
    }
    if (url.hostname !== "provider.test") throw new Error("The public provider fixture cannot contact another origin.");
    const route = url.pathname.replace("/api/agent/v2/coding", ""), parts = route.split("/").filter(Boolean);
    if (route === "/history/ack" && method === "POST" && installationHistory) {
      const receipt = JSON.parse(body);
      if (receipt.epoch !== "fixture-" + receipt.sessionId || receipt.through > (historyPositions.get(receipt.sessionId) ?? 0)) return error("invalid_ack", "Invalid cursor.");
      return json({ through: receipt.through });
    }
    if (route === "/history/events" && behavior.legacyHistoryRoute)
      return error("unsupported_operation", "Use a declared agent v1 operation.", 422);
    if (route === "/history/events" && installationHistory) {
      if (new Headers(init?.headers).get("authorization") !== "Bearer installation-read-only") return error("permission_denied", "Wrong authority.", 403);
      const after = Number((url.searchParams.get("after") ?? "feed-0").slice(5));
      if (expireHistoricalCursor && url.searchParams.has("after")) { expireHistoricalCursor = false; return error("history_cursor_expired", "Cursor expired.", 410); }
      if (new Headers(init?.headers).get("accept") === "application/json") {
        const through = Number((url.searchParams.get("through") ?? "feed-" + history.length).slice(5));
        const end = Math.min(through, after + Number(url.searchParams.get("limit") ?? "100"));
        const observations = history.slice(after, end).map((frame, index) => ({ ...JSON.parse(new TextDecoder().decode(frame).split("data: ")[1]!), cursor: "feed-" + (after + index + 1) }));
        return json({ observations, through: "feed-" + through, nextCursor: end < through ? "feed-" + end : null });
      }
      if (behavior.rejectHistoryStream) return error("unavailable", "The provider stream is unavailable.", 503);
      let stream!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        stream = controller; historyStreams.add(stream);
        stream.enqueue(new TextEncoder().encode(": opened\n\n"));
        for (const frame of history.slice(after)) stream.enqueue(frame);
        init?.signal?.addEventListener("abort", () => { if (historyStreams.delete(stream)) stream.close(); }, { once: true });
      }, cancel() { historyStreams.delete(stream); } });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }
    if (route === "/capabilities" && starts.length && behavior.capabilitiesTimeoutAfterStart)
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    if (route === "/capabilities") return json(capabilities);
    if (route === "/connections") return json({ connections: [{ id: "account", revision: behavior.connectionRevision, name: "Account", ready: true }], nextCursor: null });
    if (route === "/connections/account/models") return json({ revision: "1", models: [{ id: "model", reasoningEfforts: [null] }], defaultModel: "model" });
    if (parts[0] === "sessions" && parts.length === 2) {
      const id = parts[1]!;
      if (method === "GET" && behavior.sessionLookupGate) await behavior.sessionLookupGate;
      if (method === "GET" && behavior.failSessionLookup) return error("provider_unavailable", "Session lookup temporarily unavailable.", 503);
      if (method === "PUT") {
        const configuration = JSON.parse(body).configuration as AgentConfiguration;
        const session: AgentSession = { ref: { provider, id }, revision: "1", configurationRevision: "1", configurationDigest: digest(configuration),
          configuration, nativeState: "not_created", activeRun: null, resolvedSkills: [] };
        if (!sessions.has(id)) sessions.set(id, session);
      }
      return sessions.has(id) ? json(sessions.get(id)) : error("session_not_found", "Session not found.", 404);
    }
    if (parts[0] === "sessions" && parts[2] === "configurations") {
      const session = sessions.get(parts[1]!)!, configuration = JSON.parse(body).configuration as AgentConfiguration;
      session.configuration = configuration; session.configurationDigest = digest(configuration);
      session.revision = String(BigInt(session.revision) + 1n); session.configurationRevision = String(BigInt(session.configurationRevision) + 1n);
      return json(session);
    }
    if (parts[0] === "sessions" && parts[2] === "runs") {
      if (behavior.startGate) await behavior.startGate;
      const sessionId = parts[1]!, runId = parts[3]!, previous = starts.find(start => start.runId === runId);
      if (behavior.refuseNextStart) {
        delete behavior.refuseNextStart;
        refusedStarts.set(runId, { sessionId, body });
        return error("storage_uncertain", "Retained provider state requires recovery.", 503);
      }
      if (previous && previous.body !== body) return error("request_conflict", "Run UUID has different bytes.");
      if (!previous) {
        const runInput = JSON.parse(body) as AgentRunInput, session = sessions.get(sessionId)!;
        starts.push({ runId, sessionId, input: runInput, body });
        const snapshot: AgentRunSnapshot = { ref: { provider, id: runId }, sessionId, generation: randomUUID(), revision: "1", state: "running",
          phase: "executing", stopConfirmed: false, freshness: "current", observedAt: new Date().toISOString(), configurationRevision: session.configurationRevision,
          lastSequence: "0", cursor: "cursor-0", pending: [], effects: { certainty: "known", unresolvedCallIds: [] }, messages: [], tools: [] };
        runs.set(runId, snapshot); events.set(runId, []); session.activeRun = snapshot.ref; session.nativeState = "available";
        publishHistory(sessionId, runId, runOwners.get(runId) ?? owner, { kind: "snapshot", snapshot });
      }
      if (behavior.loseNextStartResponse) { delete behavior.loseNextStartResponse; throw new TypeError("fetch failed", { cause: new Error("Fixture lost the start response after admission.") }); }
      return json(runs.get(runId));
    }
    if (parts[0] === "runs") {
      const runId = parts[1]!;
      const refused = refusedStarts.get(runId);
      if (!runs.has(runId) && refused && parts[2] === "stop") {
        const input = JSON.parse(body), fence = input.fenceIfNotAdmitted;
        if (fence && (fence.sessionId !== refused.sessionId || fence.startDigest !== createHash("sha256").update(refused.body).digest("hex")))
          return error("request_conflict", "The cancel fence must identify the original start.");
        if (behavior.cancel === "unavailable") {
          controls.push({ runId, input, path: route });
          return error("storage_uncertain", "Retained provider state requires recovery.", 503);
        }
        runs.set(runId, { ref: { provider, id: runId }, sessionId: refused.sessionId, generation: randomUUID(), revision: "1",
          state: "cancelled", phase: "terminal", stopConfirmed: true, freshness: "current", observedAt: new Date().toISOString(),
          configurationRevision: sessions.get(refused.sessionId)!.configurationRevision, lastSequence: "0", cursor: "cursor-0",
          pending: [], effects: { certainty: "known", unresolvedCallIds: [] }, messages: [], tools: [],
          result: { status: "cancelled", error: { code: "run_not_admitted", message: "The original request was fenced before native admission.", retryable: false } } });
      }
      const snapshot = runs.get(runId);
      if (!snapshot) return error("run_not_found", "Run not found.", 404);
      if (parts[2] === "discard") {
        const requestId = (JSON.parse(body) as { requestId: string }).requestId;
        if (!snapshot.stopConfirmed) return error("discard_pending", "The scope remains active.", 409);
        return json({ runId, requestId, state: "discarded" });
      }
      if (parts[2] === "closure") return json({ ref: snapshot.ref, sessionId: snapshot.sessionId, generation: snapshot.generation,
        revision: snapshot.revision, stopConfirmed: snapshot.stopConfirmed, state: snapshot.state, phase: snapshot.phase, pendingContinuations: snapshot.pendingContinuations });
      if (parts.length === 2 && behavior.snapshotIssue === "denied") return error("permission_denied", "Owner credential expired.", 403);
      if (parts.length === 2 && behavior.snapshotIssue === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      if (parts.length === 2) return json(snapshot);
      if (parts[2] === "events") {
        const after = BigInt((url.searchParams.get("after") ?? "cursor-0").replace("cursor-", ""));
        let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
        const close = () => { if (!controller) return; watchers.get(runId)?.delete(controller); try { controller.close(); } catch { /* Already cancelled. */ } controller = undefined; };
        const stream = new ReadableStream<Uint8Array>({ start(value) {
          controller = value; const set = watchers.get(runId) ?? new Set(); set.add(value); watchers.set(runId, set);
          for (const event of events.get(runId) ?? []) if (BigInt(event.sequence) > after) value.enqueue(frame(event));
          init?.signal?.addEventListener("abort", close, { once: true });
          if (init?.signal?.aborted) close();
        }, cancel() { init?.signal?.removeEventListener("abort", close); if (controller) watchers.get(runId)?.delete(controller); controller = undefined; } });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      if (parts[2] === "controls" && parts.length === 4) return receipts.has(parts[3]!) ? json(receipts.get(parts[3]!)) : error("control_not_found", "Control not found.", 404);
      const command = JSON.parse(body) as Record<string, unknown>, requestId = command.requestId as string;
      if (receipts.has(requestId)) return json(receipts.get(requestId));
      controls.push({ runId, input: command, path: route });
      if (parts[2] === "stop") {
        if (behavior.cancel === "unavailable") return error("exit_unconfirmed", "The fixture cannot confirm the original native exit.", 503);
        behavior.beforeCancel?.(runId);
        if (behavior.cancel === "unresolved") {
          update(runId, { state: "cancelled", phase: "terminal", stopConfirmed: true, pending: [],
            effects: { certainty: "unknown", unresolvedCallIds: ["command"] } });
        }
        if (!behavior.keepReservationAfterCancel) for (const control of receipts.values()) if (control.run.id === runId && control.continuation?.state === "awaiting_authorization")
          control.continuation.state = "superseded";
        update(runId, { state: "cancelled", phase: "terminal", stopConfirmed: true, pending: [] });
      } else if (parts[2] === "controls" && command.command === "barrier") update(runId, { phase: "parked", state: "waiting_for_input", stopConfirmed: true });
      else if (parts[2] === "controls" && command.command === "reconcile") {
        if (behavior.reconcile === "unavailable") return error("exit_unconfirmed", "The fixture has no authoritative exit evidence.");
        update(runId, { state: "cancelled", phase: "terminal", stopConfirmed: true, pending: [] });
      } else if (parts[2] === "controls" && command.command === "retire") {
        if (behavior.retire !== "confirmed") return error("retirement_exit_unconfirmed", "The fixture has no durable native exit proof.");
        if (command.expectedGeneration !== snapshot.generation || command.expectedRevision !== snapshot.revision)
          return error("stale_revision", "Retirement needs the exact generation and revision.");
        const session = sessions.get(snapshot.sessionId)!;
        if (session.activeRun?.id !== runId) return error("retirement_stale", "Another run owns the fixture session.");
        session.activeRun = null;
      }
      const receipt: AgentControlReceipt = { requestId, state: parts[2] === "controls" && command.command === "predictions" && behavior.deferPredictions ? "accepted" : "applied",
        run: snapshot.ref, revision: snapshot.revision, generation: snapshot.generation };
      receipts.set(requestId, receipt);
      if (parts[2] === "responses" && behavior.loseNextResponse) {
        delete behavior.loseNextResponse;
        throw new TypeError("Fixture lost the applied decision response.");
      }
      emit(runId, "control.updated", { requestId, receipt });
      if (parts[2] === "controls" && command.command === "retire" && behavior.loseNextRetireResponse) {
        delete behavior.loseNextRetireResponse;
        throw new TypeError("Fixture lost the retirement response after committing it.");
      }
      return json(receipt);
    }
    return error("fixture_route", "Unexpected provider fixture route.", 404);
  };
  const backend = new CoreAgentBackend({ coreOrigin: "http://core.test", appId: "unrelated.consumer", serviceToken: "fixture-service", fetch: fetcher });
  const makeManager = (options: { settings?: SettingsStore; providers?: ProviderDirectory; development?: DevelopmentClient; profiles?: ProfileStore } = {}) => {
    const store = new SessionStore(path.join(root, "consumer-data"), path.join(root, "consumer-cache"));
    const directory = new AgentConnectionDirectory(store.dataDir, backend);
    const fallback: HarnessAdapter = { name: "Provider selection required", capabilities: { questions: false, appMcp: false, autoAllow: false, denyReason: false, liveReconfigure: false },
      probe: async () => ({ available: false }), start: () => { throw new Error("No engine is embedded in this public consumer fixture."); } };
    let manager: SessionManager;
    const connections = new AgentConsumerConnections({ directory, backend, authority: async () => credential,
      adapter: (...args) => manager.providerAdapter(...args) });
    manager = new SessionManager(store, fallback, new AuditReporter(null, null, "unrelated.consumer"), path.join(root, "fallback"),
      options.settings ?? null, options.providers ?? null, null, null, null, null, connections, options.development ?? null, null, "docker", options.profiles ?? null, backend);
    managers.push(manager); return { manager, store, connections };
  };
  const initial = makeManager();
  await initial.connections.setDefault(connectionId);
  return { ...initial, root, owner, credential, provider, selection, connectionId, capabilities, sessions, runs, starts, controls, receipts,
    requests, authorizations, behavior, emit, update, makeManager, publishHistory,
    setHistoryDenied(value: boolean) { denyHistory = value; },
    expireNextHistoryCursor() { expireHistoricalCursor = true; },
    activeHistoryStreams() { return historyStreams.size; },
    disconnectHistory() { for (const stream of historyStreams) stream.close(); historyStreams.clear(); },
    snapshot: (runId: string) => structuredClone(runs.get(runId)!),
    reconnect(runId: string) {
      const active = watchers.get(runId); watchers.delete(runId);
      for (const watcher of active ?? []) watcher.close();
    },
    complete(runId: string, text = "Completed", stopConfirmed = true) {
      return update(runId, { state: stopConfirmed ? "succeeded" : "running", phase: stopConfirmed ? "terminal" : "finalizing", stopConfirmed,
        messages: [{ id: "message", role: "assistant", text, state: "complete" }],
        result: { status: "succeeded", text, messageId: "message" }, pending: [] });
    },
    async close() {
      for (const manager of managers) await manager.shutdown();
      for (const set of watchers.values()) for (const watcher of set) try { watcher.close(); } catch { /* Reader already detached. */ }
      watchers.clear(); await rm(root, { recursive: true, force: true });
    },
  };
}
export type PublicProviderFixture = Awaited<ReturnType<typeof publicProviderFixture>>;
