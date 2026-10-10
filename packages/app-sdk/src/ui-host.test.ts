// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUiHost, type UiHost } from "./ui-host";
import { createPresentationRequestId } from "./ui";
import { EmbeddedUiClient } from "./ui-embedded";
import type { UiBootstrap, UiPanel, UiResolvedPanel } from "./ui-types";

vi.mock("./browser-auth", () => ({ appFetch: (...args: Parameters<typeof fetch>) => fetch(...args) }));
const panel = { appId: "assistant", installationId: "install-1", panelId: "chat" };
const target = { panel, route: "/assistant?session=existing" };
const policy = { microphone: true, popupEscape: false };
const bootstrap: UiBootstrap = { version: 1, coreOrigin: "https://core.test", userId: "alice", canHost: true, pinnedOpen: true,
  app: { appId: "host", installationId: "host-1", origins: ["http://localhost:3000"] } };
const catalog: UiPanel = { panel, route: "/assistant", endpoint: "web", origin: "https://assistant.test", label: "Assistant", appName: "Assistant", icon: "bot", available: true, state: "running", canStart: false, framePolicy: policy };
const resolved: UiResolvedPanel = { target, surface: { appId: "assistant", installationId: "install-1", endpoint: "web", route: target.route, origin: "https://assistant.test", framePolicy: policy }, available: true, state: "running", standaloneHref: "https://core.test/open" };
let host: UiHost | null = null, child: EmbeddedUiClient | null = null;
let metadata: UiBootstrap, panels: UiPanel[], resolution: UiResolvedPanel;
let fetcher: ReturnType<typeof vi.fn>;
const originalParent = window.parent, originalTop = window.top;
beforeEach(() => {
  metadata = structuredClone(bootstrap); panels = structuredClone([catalog]); resolution = structuredClone(resolved);
  fetcher = vi.fn(async (path: string) => Response.json(path.includes("bootstrap") ? metadata : path.endsWith("resolve") ? resolution : { panels }));
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => {
  host?.dispose(); child?.dispose(); host = null; child = null;
  document.body.innerHTML = ""; vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers();
  Object.defineProperty(window, "parent", { configurable: true, value: originalParent });
  Object.defineProperty(window, "top", { configurable: true, value: originalTop });
});
async function start() { host = createUiHost(); await host.refresh(); return host; }
function frame() {
  const element = document.createElement("iframe"); document.body.append(element);
  const post = vi.spyOn(element.contentWindow!, "postMessage").mockImplementation(() => {});
  const release = host!.registerFrame(element, { ...resolved.surface!, panelId: panel.panelId });
  const nonce = createPresentationRequestId();
  const send = (data: object, origin = "https://assistant.test", source: unknown = element.contentWindow) => window.dispatchEvent(new MessageEvent("message", { data: { version: 1, ...data }, origin, source: source as Window }));
  send({ type: "hosty:ui:probe", childNonce: nonce, versions: [1] });
  const offer = post.mock.calls.find(([value]) => value.type === "hosty:ui:offer")![0];
  send({ ...offer, type: "hosty:ui:accept", coreOrigin: metadata.coreOrigin, userId: metadata.userId, appId: panel.appId, installationId: panel.installationId });
  return { element, post, release, send, offer };
}

describe("panel host authority and replay", () => {
  it("keeps identical finalized targets mounted and rechecks authority for a replay", async () => {
    const h = await start(), requestId = createPresentationRequestId();
    expect(await h.openSurface(target, { placement: "side", requestId })).toMatchObject({ status: "opened", readiness: "loading" });
    const f = frame();
    f.send({ ...f.offer, type: "hosty:ui:surface-state", route: target.route, state: "ready" });
    h.setExpanded(false);
    expect(await h.openSurface(target, { placement: "side", requestId })).toMatchObject({ status: "opened", readiness: "ready" });
    expect(h.getSnapshot().tools).toHaveLength(1); expect(h.getSnapshot().expanded).toBe(true);
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("resolve"))).toHaveLength(2);
    expect(await h.openSurface({ ...target, route: "/assistant?session=other" }, { placement: "side", requestId })).toMatchObject({ status: "rejected", code: "request_conflict" });
  });
  it("rejects strangers, stale generations and different accounts before dispatch", async () => {
    const h = await start(); await h.openSurface(target, { placement: "side", requestId: createPresentationRequestId() });
    const f = frame(), ready = { ...f.offer, type: "hosty:ui:surface-state", route: target.route, state: "ready" };
    f.send(ready, "https://foreign.test"); f.send(ready, "https://assistant.test", window);
    expect(h.getSnapshot().tools[0]!.readiness).toBe("loading");
    f.element.dispatchEvent(new Event("load")); f.send(ready);
    expect(h.getSnapshot().tools[0]!.readiness).toBe("loading");
    f.send({ type: "hosty:ui:probe", childNonce: createPresentationRequestId(), versions: [1] });
    const offer = f.post.mock.calls.filter(([v]) => v.type === "hosty:ui:offer").at(-1)![0];
    f.send({ ...offer, type: "hosty:ui:accept", coreOrigin: metadata.coreOrigin, userId: "bob", appId: panel.appId, installationId: panel.installationId });
    expect(f.post.mock.calls.at(-1)![0]).toMatchObject({ code: "actor_mismatch" });
    const count = fetcher.mock.calls.length;
    f.send({ ...offer, type: "hosty:ui:open", requestId: createPresentationRequestId(), target, placement: "side" });
    expect(fetcher).toHaveBeenCalledTimes(count);
  });
  it("accepts only exact-route readiness and clears an old document's ledger", async () => {
    const h = await start(), f = frame(), requestId = createPresentationRequestId();
    f.send({ ...f.offer, type: "hosty:ui:open", requestId, target, placement: "side" });
    await vi.waitFor(() => expect(h.getSnapshot().tools).toHaveLength(1));
    f.send({ ...f.offer, type: "hosty:ui:surface-state", route: "/assistant?session=other", state: "ready" });
    expect(h.getSnapshot().tools[0]!.readiness).toBe("loading");
    f.send({ ...f.offer, type: "hosty:ui:surface-state", route: target.route, state: "ready" });
    expect(h.getSnapshot().tools[0]!.readiness).toBe("ready");
    expect(f.post.mock.calls.some(([v]) => v.result?.readiness === "ready")).toBe(true);
    f.element.dispatchEvent(new Event("load"));
    expect(h.getSnapshot().tools[0]!.readiness).toBe("loading");
    f.release();
    expect(await h.getPresentation(requestId)).toMatchObject({ status: "unknown" });
  });
  it("replaces auth-required with bounded unreported readiness after recovery by an older tool", async () => {
    const h = await start(); await h.openSurface(target, { placement: "side", requestId: createPresentationRequestId() });
    const f = frame(); vi.useFakeTimers();
    f.send({ ...f.offer, type: "hosty:ui:auth-required" });
    await vi.advanceTimersByTimeAsync(6_000); expect(h.getSnapshot().tools[0]!.readiness).toBe("auth-required");
    f.send({ ...f.offer, type: "hosty:ui:accept", coreOrigin: metadata.coreOrigin, userId: metadata.userId, appId: panel.appId, installationId: panel.installationId });
    expect(h.getSnapshot().tools[0]!.readiness).toBe("loading");
    await vi.advanceTimersByTimeAsync(5_001); expect(h.getSnapshot().tools[0]!.readiness).toBe("unreported");
  });
  it("treats an aborted wait as uncertain while the dispatched operation can still complete", async () => {
    const h = await start(), abort = new AbortController(), requestId = createPresentationRequestId();
    let finish!: (v: Response) => void;
    fetcher.mockImplementation(async (path: string) => path.endsWith("resolve") ? new Promise<Response>(r => { finish = r; }) : Response.json(metadata));
    const operation = h.openSurface(target, { placement: "side", requestId, signal: abort.signal });
    await vi.waitFor(() => expect(finish).toBeDefined()); abort.abort();
    expect(await operation).toMatchObject({ status: "uncertain" });
    finish(Response.json(resolved)); await vi.waitFor(() => expect(h.getSnapshot().tools).toHaveLength(1));
    fetcher.mockImplementation(async (path: string) => Response.json(path.endsWith("resolve") ? resolved : metadata));
    expect(await h.getPresentation(requestId)).toMatchObject({ status: "opened" });
  });
  it("unmounts withdrawn access/policy but retains tools through transient readiness loss", async () => {
    const h = await start(); await h.openSurface(target, { placement: "side", requestId: createPresentationRequestId() });
    panels = [{ ...catalog, state: "unavailable", available: false }]; await h.refresh();
    expect(h.getSnapshot().tools[0]!.resolved.surface).not.toBeNull();
    panels = [{ ...catalog, framePolicy: { microphone: false, popupEscape: false } }]; await h.refresh();
    expect(h.getSnapshot().tools[0]!.resolved.surface).toBeNull();
    metadata = { ...metadata, canHost: false }; await h.refresh();
    expect(h.getSnapshot().tools).toEqual([]);
  });
  it("clears actor-scoped targets and forbids a second composition owner", async () => {
    const h = await start(); expect(() => createUiHost()).toThrow("already owns");
    await h.openSurface(target, { placement: "side", requestId: createPresentationRequestId() });
    const f = frame();
    metadata = { ...metadata, userId: "bob" }; await h.refresh(); expect(h.getSnapshot().tools).toEqual([]);
    const request = f.post.mock.calls.filter(([v]) => v.type === "hosty:ui:probe-request").at(-1)![0];
    expect(request.generation).not.toBe(f.offer.generation);
    f.send({ ...f.offer, type: "hosty:ui:open", requestId: createPresentationRequestId(), target, placement: "side" });
    expect(h.getSnapshot().tools).toEqual([]);
  });
  it.each([{ origin: "https://moved.test" }, { endpoint: "other" }, { route: "/new-entry" }])("invalidates a mounted destination after metadata changes: %j", async change => {
    const h = await start(); await h.openSurface(target, { placement: "side", requestId: createPresentationRequestId() });
    panels = [{ ...catalog, ...change }]; await h.refresh();
    expect(h.getSnapshot().tools[0]!.resolved).toMatchObject({ surface: null, state: "destination_changed" });
  });
  it("does not report a retained frame ready when its resolved origin has moved", async () => {
    const h = await start(), requestId = createPresentationRequestId();
    await h.openSurface(target, { placement: "side", requestId });
    resolution = { ...resolution, surface: { ...resolution.surface!, origin: "https://moved.test" } };
    expect(await h.getPresentation(requestId)).toMatchObject({ status: "blocked", code: "destination_changed" });
  });
  it("rejects an in-flight placement across a Core origin change", async () => {
    const h = await start(); let finish!: (v: Response) => void;
    fetcher.mockImplementation(async (path: string) => path.endsWith("resolve") ? new Promise<Response>(r => { finish = r; })
      : Response.json(path.includes("bootstrap") ? metadata : { panels }));
    const result = h.openSurface(target, { placement: "side", requestId: createPresentationRequestId() });
    await vi.waitFor(() => expect(finish).toBeDefined());
    metadata = { ...metadata, coreOrigin: "https://other-core.test" }; await h.refresh(); finish(Response.json(resolved));
    expect(await result).toMatchObject({ status: "blocked", code: "actor_mismatch" });
    expect(h.getSnapshot().tools).toHaveLength(0);
  });
});

describe("embedded panel discovery", () => {
  function begin(nested = false) {
    const parent = { postMessage: vi.fn() };
    Object.defineProperty(window, "parent", { configurable: true, value: parent });
    Object.defineProperty(window, "top", { configurable: true, value: nested ? {} : parent });
    metadata = { ...metadata, app: { appId: "plans", installationId: "plans-1", origins: ["http://localhost:3000"] }, canHost: false,
      peer: { appId: "host", installationId: "host-1", origins: ["https://shell.test"] } };
    child = new EmbeddedUiClient("/api/hosty/ui");
    const probe = parent.postMessage.mock.calls[0]?.[0];
    const offer = { version: 1, type: "hosty:ui:offer", childNonce: probe?.childNonce, hostWindowId: createPresentationRequestId(), generation: createPresentationRequestId() };
    const send = (data: object, origin = "https://shell.test", source: unknown = parent) => window.dispatchEvent(new MessageEvent("message", { data, origin, source: source as Window }));
    return { parent, probe, offer, send };
  }
  async function connect() {
    const f = begin(); f.send(f.offer);
    await vi.waitFor(() => expect(f.parent.postMessage.mock.calls.at(-1)![0].type).toBe("hosty:ui:accept"));
    f.send({ ...f.offer, type: "hosty:ui:connected", coreOrigin: metadata.coreOrigin, userId: metadata.userId, appId: "host", installationId: "host-1" });
    return f;
  }
  it("discovers without identity, verifies the observed parent and uses exact-origin messages", async () => {
    const f = await connect();
    expect(Object.keys(f.probe).sort()).toEqual(["childNonce", "type", "version", "versions"]);
    expect(f.parent.postMessage.mock.calls[0]![1]).toBe("*");
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining("parentOrigin=https%3A%2F%2Fshell.test"), expect.anything());
    expect(child!.getEnvironment().connection).toBe("connected");
    const requestId = createPresentationRequestId(), result = child!.openSurface(target, { placement: "side", requestId });
    await vi.waitFor(() => expect(f.parent.postMessage.mock.calls.at(-1)![0].type).toBe("hosty:ui:open"));
    expect(f.parent.postMessage.mock.calls.at(-1)![1]).toBe("https://shell.test");
    f.send({ ...f.offer, type: "hosty:ui:result", requestId, result: { status: "opened", requestId, target, readiness: "ready" } });
    expect(await result).toMatchObject({ status: "opened", readiness: "ready" });
  });
  it("does not disclose identity to an unverified origin or wrong window", async () => {
    const f = begin(); f.send(f.offer, "https://shell.test", {}); expect(fetcher).not.toHaveBeenCalled();
    f.send(f.offer, "https://foreign.test");
    await vi.waitFor(() => expect(child!.getEnvironment().connection).toBe("blocked"));
    expect(f.parent.postMessage).toHaveBeenCalledTimes(1);
  });
  it("blocks protected composition on account mismatch, including a later actor change", async () => {
    const f = await connect();
    f.send({ ...f.offer, type: "hosty:ui:connected", coreOrigin: metadata.coreOrigin, userId: "bob", appId: "host", installationId: "host-1" });
    expect(child!.getEnvironment()).toMatchObject({ connection: "blocked", code: "actor_mismatch" });
    expect(await child!.openSurface(target, { placement: "side", requestId: createPresentationRequestId() })).toMatchObject({ status: "blocked" });
  });
  it("refuses nested ownership without posting or contacting Core", async () => {
    const f = begin(true); expect(child!.getEnvironment().code).toBe("unsupported_nesting");
    expect(f.parent.postMessage).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
  it("keeps protected composition blocked while a known host's verification is delayed", async () => {
    vi.useFakeTimers(); const f = begin();
    fetcher.mockImplementation(() => new Promise(() => {})); f.send(f.offer);
    await vi.advanceTimersByTimeAsync(5_001);
    expect(child!.getEnvironment()).toMatchObject({ connection: "blocked", code: "host_unavailable" });
    expect(f.parent.postMessage.mock.calls.every(([v]) => v.type === "hosty:ui:probe")).toBe(true);
  });
  it("renews bounded discovery after app-owned authentication and forwards only unhandled Escape", async () => {
    const f = await connect(); vi.useFakeTimers();
    const count = f.parent.postMessage.mock.calls.length;
    const handled = new KeyboardEvent("keydown", { key: "Escape", cancelable: true }); handled.preventDefault(); window.dispatchEvent(handled);
    expect(f.parent.postMessage).toHaveBeenCalledTimes(count);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(f.parent.postMessage.mock.calls.at(-1)![0].type).toBe("hosty:ui:dismiss");
    child!.setActive(false); expect(f.parent.postMessage.mock.calls.at(-1)![0].type).toBe("hosty:ui:auth-required");
    child!.setActive(true); await vi.advanceTimersByTimeAsync(5_001);
    expect(child!.getEnvironment().connection).toBe("blocked");
  });
});
