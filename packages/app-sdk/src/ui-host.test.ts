// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUiHost, type UiHost, type UiViewDescriptor } from "./ui-host";
import { createPresentationRequestId } from "./ui";
import { EmbeddedUiClient } from "./ui-embedded";
import { routeWithin, type UiBootstrap, type UiPanel, type UiResolvedPanel } from "./ui-types";

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
async function start() {
  host = createUiHost();
  host.registerWorkspace({ workspaceId: "default", renderer: {
    present: async () => "accepted", focus() {}, collapse() {}, release() {}, showToolPicker: async () => "accepted",
  } });
  await host.refresh(); return host;
}
function frame(surface = resolved.surface!, view?: UiViewDescriptor) {
  const element = document.createElement("iframe"); document.body.append(element);
  const post = vi.spyOn(element.contentWindow!, "postMessage").mockImplementation(() => {});
  const release = host!.registerFrame(element, { ...surface, panelId: panel.panelId }, undefined, view);
  const nonce = createPresentationRequestId();
  const send = (data: object, origin = "https://assistant.test", source: unknown = element.contentWindow) => window.dispatchEvent(new MessageEvent("message", { data: { version: 1, ...data }, origin, source: source as Window }));
  send({ type: "hosty:ui:probe", childNonce: nonce, versions: [1] });
  const offer = post.mock.calls.find(([value]) => value.type === "hosty:ui:offer")![0];
  send({ ...offer, type: "hosty:ui:accept", coreOrigin: metadata.coreOrigin, userId: metadata.userId, appId: panel.appId, installationId: panel.installationId });
  return { element, post, release, send, offer };
}

describe("panel host authority and replay", () => {
  it.each(["actor", "core", "installation", "permission", "dispose"])("releases non-React rendered frames at the %s boundary", async boundary => {
    host = createUiHost(); const h = host, releases = [vi.fn(), vi.fn()];
    const mounted = new Map<string, HTMLIFrameElement>();
    ["default", "floating"].forEach((workspaceId, index) => h.registerWorkspace({ workspaceId, renderer: {
      async present(tool) { const element = document.createElement("iframe"); document.body.append(element); mounted.set(tool.presentationId, element); return "accepted"; },
      focus() {}, collapse() {}, showToolPicker: async () => "accepted",
      release(id) { releases[index]!(id); mounted.get(id)?.remove(); mounted.delete(id); },
    } }));
    await h.refresh();
    for (const workspaceId of ["default", "floating"]) {
      h.setPlacementResolver(() => ({ workspaceId }));
      await h.openSurface(target, { placement: "side", requestId: createPresentationRequestId() });
    }
    expect(document.querySelectorAll("iframe")).toHaveLength(2);
    if (boundary === "dispose") h.dispose();
    else {
      if (boundary === "actor") metadata = { ...metadata, userId: "bob" };
      if (boundary === "core") metadata = { ...metadata, coreOrigin: "https://other-core.test" };
      if (boundary === "installation") metadata = { ...metadata, app: { ...metadata.app, installationId: "replacement" } };
      if (boundary === "permission") metadata = { ...metadata, canHost: false };
      await h.refresh();
    }
    expect(document.querySelectorAll("iframe")).toHaveLength(0); expect(mounted.size).toBe(0);
    releases.forEach(release => expect(release).toHaveBeenCalledOnce());
    expect(h.getSnapshot().tools).toHaveLength(0);
    expect(h.getSnapshot().workspaces?.every(workspace => !workspace.expanded && workspace.selectedId === null)).toBe(true);
    h.dispose(); releases.forEach(release => expect(release).toHaveBeenCalledOnce());
  });
  it.each(["host activity", "child authentication"])("does not send old ledger results after %s renewal", async renewal => {
    const h = await start();
    await h.openSurface(target, { placement: "side", requestId: createPresentationRequestId() });
    const f = frame(), requestId = createPresentationRequestId();
    f.send({ ...f.offer, type: "hosty:ui:open", requestId, target, placement: "side" });
    await vi.waitFor(() => expect(f.post.mock.calls.some(([m]) => m.type === "hosty:ui:result" && m.requestId === requestId)).toBe(true));
    if (renewal === "host activity") { h.setActive(false); h.setActive(true); await h.refresh(); }
    else f.send({ ...f.offer, type: "hosty:ui:auth-required" });
    f.send({ type: "hosty:ui:probe", childNonce: createPresentationRequestId(), versions: [1] });
    const offer = f.post.mock.calls.filter(([m]) => m.type === "hosty:ui:offer").at(-1)![0];
    f.send({ ...offer, type: "hosty:ui:accept", coreOrigin: metadata.coreOrigin, userId: metadata.userId, appId: panel.appId, installationId: panel.installationId });
    const next = { ...target, route: "/assistant?session=new" };
    let finish!: (response: Response) => void;
    fetcher.mockImplementation(async (path: string) => path.endsWith("resolve")
      ? new Promise<Response>(resolve => { finish = resolve; }) : Response.json(metadata));
    f.post.mockClear();
    f.send({ ...offer, type: "hosty:ui:open", requestId, target: next, placement: "side" });
    await vi.waitFor(() => expect(finish).toBeDefined());
    f.send({ ...offer, type: "hosty:ui:surface-state", route: target.route, state: "ready" });
    expect(f.post.mock.calls.filter(([m]) => m.type === "hosty:ui:result" && m.requestId === requestId)).toHaveLength(0);
    finish(Response.json({ ...resolved, target: next, surface: { ...resolved.surface!, route: next.route } }));
    await vi.waitFor(() => expect(f.post.mock.calls.filter(([m]) => m.type === "hosty:ui:result" && m.requestId === requestId)).toHaveLength(1));
    expect(f.post.mock.calls.find(([m]) => m.type === "hosty:ui:result")![0]).toMatchObject({
      generation: offer.generation, childNonce: offer.childNonce, result: { status: "opened", target: next },
    });
  });
  it.each([{ route: "/assistant-v2" }, { origin: "https://moved.test" }, { endpoint: "new-web" }])(
    "selects the current default after a panel destination moves: %j", async change => {
      const h = await start();
      await h.openSurface(target, { placement: "side", requestId: createPresentationRequestId() });
      const current = { ...catalog, ...change }; panels = [current]; await h.refresh();
      expect(h.getSnapshot().tools[0]!.resolved).toMatchObject({ surface: null, state: "destination_changed" });
      fetcher.mockImplementation(async (path: string, init?: RequestInit) => {
        if (!path.endsWith("resolve")) return Response.json(metadata);
        const requested = JSON.parse(init!.body as string);
        if (requested.route && !routeWithin(requested.route, current.route))
          return Response.json({ code: "destination_invalid" }, { status: 400 });
        const route = requested.route ?? current.route;
        return Response.json({ ...resolved, target: { panel, route }, surface: {
          ...resolved.surface!, route, origin: current.origin, endpoint: current.endpoint,
        } });
      });
      if (change.route) expect(await h.openSurface(target, { placement: "side", requestId: createPresentationRequestId() }))
        .toMatchObject({ status: "blocked", code: "destination_invalid" });
      expect(await h.selectPanel(panel)).toMatchObject({ status: "opened", target: { panel, route: current.route } });
      expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body)).toEqual({ panel });
    });
  it("preserves a deep route while the retained panel surface remains valid", async () => {
    const h = await start();
    await h.openSurface(target, { placement: "side", requestId: createPresentationRequestId() });
    panels = [{ ...catalog, state: "unavailable", available: false }]; await h.refresh();
    expect(h.getSnapshot().tools[0]!.resolved.surface).not.toBeNull();
    expect(await h.selectPanel(panel)).toMatchObject({ status: "opened", target });
    expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body)).toEqual(target);
  });
  it.each([{ origin: "https://moved.test" }, { framePolicy: { microphone: false, popupEscape: false } }])(
    "invalidates a retained frame when selection discovers a changed surface before catalog refresh: %j", async change => {
      const h = await start();
      await h.openSurface(target, { placement: "side", requestId: createPresentationRequestId() });
      resolution = { ...resolved, surface: { ...resolved.surface!, ...change } };
      expect(await h.selectPanel(panel)).toMatchObject({ status: "blocked", code: "destination_changed" });
      expect(h.getSnapshot().tools[0]!.resolved.surface).toBeNull();
    });
  it("does not reopen a retained tool when a pending rail selection is superseded by collapse", async () => {
    const h = await start();
    await h.openSurface(target, { placement: "side", requestId: createPresentationRequestId() });
    let finish!: (response: Response) => void;
    fetcher.mockImplementation(async (path: string) => path.endsWith("resolve")
      ? new Promise<Response>(resolve => { finish = resolve; }) : Response.json(metadata));
    const selecting = h.selectPanel(panel);
    await vi.waitFor(() => expect(finish).toBeDefined());
    h.collapseWorkspace("default"); finish(Response.json(resolved));
    expect(await selecting).toMatchObject({ status: "blocked", code: "presentation_superseded" });
    expect(h.getSnapshot()).toMatchObject({ expanded: false });
    expect(h.getSnapshot().tools).toHaveLength(1);
  });
  it.each([
    ["hosty_launch=native", "/assistant?session=one+two#turn", "ready"],
    ["hosty_launch=embedded&hosty_launch=native", "/assistant?session=one%20two#turn", "ready"],
    ["hosty%5Flaunch=native&hosty_theme=dark&hosty_theme_preference=system", "/assistant?session=one+two&hosty_launch=embedded&hosty_theme=light#turn", "ready"],
    ["hosty_launch=native", "/assistant?session=other#turn", "loading"],
    ["hosty_launch=native", "/assistant?session=one+two#different", "loading"],
    ["hosty_launch=native", "/other?session=one+two#turn", "loading"],
  ])("matches readiness without reserved parameters (%s, %s)", async (launch, route, expected) => {
    const withLaunch = { ...target, route: `/assistant?session=one%20two&${launch}#turn` };
    resolution = { ...resolved, target: withLaunch, surface: { ...resolved.surface!, route: withLaunch.route } };
    const h = await start();
    await h.openSurface(withLaunch, { placement: "side", requestId: crypto.randomUUID() });
    const f = frame(resolution.surface!);
    f.send({ ...f.offer, type: "hosty:ui:surface-state", route, state: "ready" });
    expect(h.getSnapshot().tools[0]!.readiness).toBe(expected);
  });
  it("suspends local calls, frame traffic and focus refresh until activity revalidation and a new handshake", async () => {
    const h = await start(), requestId = createPresentationRequestId();
    await h.openSurface(target, { placement: "side", requestId });
    const f = frame();
    h.setActive(false);
    const calls = fetcher.mock.calls.length, posts = f.post.mock.calls.length;
    expect(await h.openSurface(target, { placement: "side", requestId })).toMatchObject({ status: "blocked", code: "activity_required" });
    expect(await h.getPresentation(requestId)).toMatchObject({ status: "blocked", code: "activity_required" });
    window.dispatchEvent(new Event("focus")); await h.refresh();
    f.send({ ...f.offer, type: "hosty:ui:open", requestId, target, placement: "side" });
    f.send({ ...f.offer, type: "hosty:ui:surface-state", route: target.route, state: "ready" });
    expect(fetcher).toHaveBeenCalledTimes(calls); expect(f.post).toHaveBeenCalledTimes(posts);
    expect(h.getSnapshot().tools[0]!.readiness).toBe("loading");
    h.setActive(true); await h.refresh();
    expect(h.getEnvironment().connection).toBe("connected");
    f.send({ ...f.offer, type: "hosty:ui:open", requestId, target, placement: "side" });
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("resolve"))).toHaveLength(1);
    f.send({ type: "hosty:ui:probe", childNonce: createPresentationRequestId(), versions: [1] });
    const offer = f.post.mock.calls.filter(([msg]) => msg.type === "hosty:ui:offer").at(-1)![0];
    expect(offer.generation).not.toBe(f.offer.generation);
    f.send({ ...offer, type: "hosty:ui:accept", coreOrigin: metadata.coreOrigin, userId: metadata.userId, appId: panel.appId, installationId: panel.installationId });
    f.send({ ...offer, type: "hosty:ui:surface-state", route: target.route, state: "ready" });
    expect(h.getSnapshot().tools[0]!.readiness).toBe("ready");
    expect(await h.getPresentation(requestId)).toMatchObject({ status: "opened", readiness: "ready" });
  });
  it.each(["bootstrap", "resolve"])("refuses a placement suspended during %s even after activity resumes", async pending => {
    const h = await start();
    let release!: () => void, entered!: () => void, held = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    fetcher.mockImplementation(async (path: string) => {
      if (!held && path.endsWith(pending)) { held = true; entered(); await gate; }
      return Response.json(path.includes("bootstrap") ? metadata : path.endsWith("resolve") ? resolved : { panels });
    });
    const requestId = createPresentationRequestId();
    const opening = h.openSurface(target, { placement: "side", requestId });
    await waiting; h.setActive(false); h.setActive(true); await h.refresh(); release();
    expect(await opening).toMatchObject({ status: "blocked", code: "activity_required" });
    expect(h.getSnapshot().tools).toHaveLength(0);
    expect(await h.openSurface(target, { placement: "side", requestId })).toMatchObject({ status: "opened" });
  });
  it("does not dispatch a queued placement from before activity suspension", async () => {
    const h = await start();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    fetcher.mockImplementation(async (path: string) => {
      if (path.endsWith("resolve")) { entered(); await gate; }
      return Response.json(path.includes("bootstrap") ? metadata : path.endsWith("resolve") ? resolved : { panels });
    });
    const first = h.openSurface(target, { placement: "side", requestId: createPresentationRequestId() });
    await waiting;
    const second = h.openSurface({ ...target, route: "/assistant?session=queued" }, { placement: "side", requestId: createPresentationRequestId() });
    h.setActive(false); h.setActive(true); await h.refresh(); release();
    for (const result of await Promise.all([first, second])) expect(result).toMatchObject({ status: "blocked", code: "activity_required" });
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("resolve"))).toHaveLength(1);
    expect(h.getSnapshot().tools).toHaveLength(0);
  });
  it.each(["success", "failure"])("ignores a stale refresh %s from before renewal", async outcome => {
    const h = await start();
    let finish!: (value: Response) => void, reject!: (error: Error) => void, held = false;
    fetcher.mockImplementation(async (path: string) => {
      if (!held && path.endsWith("panels")) {
        held = true; return new Promise<Response>((resolve, fail) => { finish = resolve; reject = fail; });
      }
      return Response.json(path.includes("bootstrap") ? metadata : { panels });
    });
    const old = h.refresh(); await vi.waitFor(() => expect(finish).toBeDefined());
    h.setActive(false); h.setActive(true); await h.refresh();
    if (outcome === "success") finish(Response.json({ panels: [] })); else reject(new Error("Old failure"));
    await old;
    expect(h.getEnvironment().connection).toBe("connected");
    expect(h.getSnapshot().catalog).toEqual(panels);
    expect(h.getSnapshot().error).toBeNull();
  });
  it("keeps renewed activity blocked after failed revalidation and clears old actor tools on recovery", async () => {
    const h = await start();
    await h.openSurface(target, { placement: "side", requestId: createPresentationRequestId() });
    h.setActive(false);
    fetcher.mockRejectedValueOnce(new Error("Offline"));
    h.setActive(true); await h.refresh();
    const calls = fetcher.mock.calls.length;
    expect(await h.openSurface(target, { placement: "side", requestId: createPresentationRequestId() })).toMatchObject({ status: "blocked", code: "activity_required" });
    expect(fetcher).toHaveBeenCalledTimes(calls);
    metadata = { ...metadata, userId: "bob" }; await h.refresh();
    expect(h.getSnapshot().tools).toHaveLength(0);
    expect(h.getEnvironment().connection).toBe("connected");
  });
  it("returns immediate busy refusals to the exact embedded sender", async () => {
    await start(); const f = frame();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    fetcher.mockImplementation(async (path: string) => {
      if (path.endsWith("resolve")) { await gate; return Response.json(resolved); }
      return Response.json(metadata);
    });
    const ids = Array.from({ length: 5 }, () => createPresentationRequestId());
    for (const requestId of ids) f.send({ ...f.offer, type: "hosty:ui:open", requestId, target, placement: "side" });
    await vi.waitFor(() => expect(f.post.mock.calls.map(([msg]) => msg.result)).toContainEqual({
      status: "blocked", requestId: ids[4], code: "presentation_busy",
    }));
    release();
    await vi.waitFor(() => expect(f.post.mock.calls.filter(([msg]) => msg.result?.status === "opened")).toHaveLength(1));
    expect(f.post.mock.calls.filter(([msg]) => msg.result?.code === "presentation_superseded")).toHaveLength(3);
  });
  it.each(["request_conflict", "invalid_presentation"])("returns immediate %s without losing the original embedded operation", async code => {
    await start(); const f = frame(), requestId = createPresentationRequestId();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    fetcher.mockImplementation(async (path: string) => {
      if (path.endsWith("resolve")) { await gate; return Response.json(resolved); }
      return Response.json(metadata);
    });
    f.send({ ...f.offer, type: "hosty:ui:open", requestId, target, placement: "side" });
    f.send({ ...f.offer, type: "hosty:ui:open", requestId,
      target: code === "request_conflict" ? { ...target, route: "/assistant?session=other" } : null, placement: "side" });
    await vi.waitFor(() => expect(f.post.mock.calls.map(([msg]) => msg.result)).toContainEqual({ status: "rejected", requestId, code }));
    release();
    await vi.waitFor(() => expect(f.post.mock.calls.filter(([msg]) => msg.result?.status === "opened")).toHaveLength(1));
  });
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
  it.each(["bootstrap", "resolve"])("does not reopen after collapse while %s is pending, but permits an explicit retry", async pending => {
    const h = await start(), requestId = createPresentationRequestId();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    fetcher.mockImplementation(async (path: string) => {
      if (path.endsWith(pending)) { entered(); await gate; }
      return Response.json(path.endsWith("resolve") ? resolved : metadata);
    });
    const opening = h.openSurface(target, { placement: "side", requestId });
    await waiting; h.setExpanded(false); release();
    expect(await opening).toMatchObject({ status: "blocked", code: "presentation_superseded" });
    expect(h.getSnapshot()).toMatchObject({ expanded: false, selected: null, tools: [] });
    expect(await h.getPresentation(requestId)).toMatchObject({ status: "blocked", code: "presentation_superseded" });
    expect(await h.openSurface(target, { placement: "side", requestId })).toMatchObject({ status: "opened" });
    expect(h.getSnapshot().expanded).toBe(true);
  });
  it("keeps the newer tool selected when an earlier resolution finishes last", async () => {
    const h = await start();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const newer = { appId: "notes", installationId: "notes-1", panelId: "notes" };
    fetcher.mockImplementation(async (path: string, init?: RequestInit) => {
      if (!path.endsWith("resolve")) return Response.json(metadata);
      const requested = JSON.parse(init!.body as string);
      if (requested.panel.appId === panel.appId) { entered(); await gate; return Response.json(resolved); }
      return Response.json({ ...resolved, target: { panel: newer, route: "/notes" },
        surface: { ...resolved.surface, appId: newer.appId, installationId: newer.installationId, route: "/notes" } });
    });
    const first = h.selectPanel(panel); await waiting;
    expect(await h.selectPanel(newer)).toMatchObject({ status: "opened" }); release();
    expect(await first).toMatchObject({ status: "blocked", code: "presentation_superseded" });
    expect(h.getSnapshot().selected).toEqual(newer);
    expect(h.getSnapshot().tools).toHaveLength(1);
  });
  it("applies only the latest queued route for the same tool", async () => {
    const h = await start();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    fetcher.mockImplementation(async (path: string, init?: RequestInit) => {
      if (!path.endsWith("resolve")) return Response.json(metadata);
      const requested = JSON.parse(init!.body as string);
      if (requested.route === target.route) { entered(); await gate; }
      return Response.json({ ...resolved, target: requested, surface: { ...resolved.surface, route: requested.route } });
    });
    const first = h.openSurface(target, { placement: "side", requestId: createPresentationRequestId() }); await waiting;
    const latest = { ...target, route: "/assistant?session=latest" };
    const second = h.openSurface(latest, { placement: "side", requestId: createPresentationRequestId() }); release();
    expect(await first).toMatchObject({ status: "blocked", code: "presentation_superseded" });
    expect(await second).toMatchObject({ status: "opened", target: latest });
    expect(h.getSnapshot().tools.map(tool => tool.target)).toEqual([latest]);
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
  it("retains transitional surfaces but still invalidates policy changes and a completed stop", async () => {
    const h = await start(); await h.openSurface(target, { placement: "side", requestId: createPresentationRequestId() });
    const surface = h.getSnapshot().tools[0]!.resolved.surface;
    for (const state of ["degraded", "stopping", "starting", "unavailable", "running"]) {
      const available = state === "running" || state === "degraded";
      panels = [{ ...catalog, state, available }]; await h.refresh();
      expect(h.getSnapshot().tools[0]!.resolved.surface).toBe(surface);
      expect(h.getSnapshot().tools[0]!.resolved).toMatchObject({ state, available });
    }
    panels = [{ ...catalog, state: "starting", available: false, framePolicy: { microphone: false, popupEscape: false } }];
    await h.refresh();
    expect(h.getSnapshot().tools[0]!.resolved).toMatchObject({ surface: null, state: "policy_changed" });
    await h.openSurface(target, { placement: "side", requestId: createPresentationRequestId() });
    panels = [{ ...catalog, state: "stopped", available: false }]; await h.refresh();
    expect(h.getSnapshot().tools[0]!.resolved).toMatchObject({ surface: null, state: "stopped" });
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
  it.each([{ origin: "https://moved.test" }, { endpoint: "other" }, { framePolicy: { microphone: false, popupEscape: false } }])(
    "revalidates the accepted destination after its presentation was closed: %j", async change => {
      const h = await start(), requestId = createPresentationRequestId();
      const opened = await h.openSurface(target, { placement: "side", requestId });
      if (opened.status !== "opened") throw new Error(opened.code);
      h.closePresentation(opened.presentationId!);
      resolution = { ...resolution, surface: { ...resolution.surface!, ...change } };
      expect(await h.getPresentation(requestId)).toMatchObject({ status: "blocked", code: "destination_changed" });
      expect(await h.openSurface(target, { placement: "side", requestId })).toMatchObject({ status: "blocked", code: "destination_changed" });
      expect(h.getSnapshot().tools).toHaveLength(0);
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
  async function reconnect(f: ReturnType<typeof begin>) {
    child!.setActive(true);
    const probe = f.parent.postMessage.mock.calls.at(-1)![0];
    const offer = { ...f.offer, childNonce: probe.childNonce };
    f.send(offer);
    await vi.waitFor(() => expect(f.parent.postMessage.mock.calls.at(-1)![0]).toMatchObject({ type: "hosty:ui:accept", childNonce: probe.childNonce }));
    f.send({ ...offer, type: "hosty:ui:connected", coreOrigin: metadata.coreOrigin, userId: metadata.userId, appId: "host", installationId: "host-1" });
    return offer;
  }
  it("negotiates explicit policy only after verification and ignores stale policy revisions", async () => {
    const f = begin();
    f.send({ ...f.offer, type: "hosty:ui:chrome", revision: 99, chrome: { navigation: "hide" } });
    expect(child!.getChrome().navigation).toBe("show");
    f.send(f.offer); await vi.waitFor(() => expect(f.parent.postMessage.mock.calls.at(-1)![0].type).toBe("hosty:ui:accept"));
    f.send({ ...f.offer, type: "hosty:ui:connected", coreOrigin: metadata.coreOrigin, userId: metadata.userId,
      appId: "host", installationId: "host-1", capabilities: ["ui.composition.v1"], revision: 2,
      chrome: { navigation: "show", tools: { launcher: "hide" } }, rootDisabled: false });
    expect(child!.getChrome()).toMatchObject({ navigation: "show", tools: { owner: "host", enabled: true, launcher: "hide" } });
    f.send({ ...f.offer, type: "hosty:ui:chrome", revision: 1, chrome: { navigation: "hide" }, rootDisabled: true });
    expect(child!.getChrome().tools.enabled).toBe(true);
    f.send({ ...f.offer, type: "hosty:ui:chrome", revision: 3, chrome: { navigation: "hide" }, rootDisabled: true });
    expect(child!.getChrome()).toMatchObject({ navigation: "hide", tools: { enabled: false } });
    expect(await child!.openSurface(target, { placement: "side", requestId: createPresentationRequestId() })).toMatchObject({ code: "tools_disabled" });
  });
  it("does not silently send composition-only options to a legacy host", async () => {
    const f = await connect(), count = f.parent.postMessage.mock.calls.length;
    expect(await child!.openSurface(target, { placement: "side", requestId: createPresentationRequestId(), reuse: "new" })).toMatchObject({ code: "unsupported_composition" });
    expect(await child!.openToolPicker({ requestId: createPresentationRequestId() })).toMatchObject({ code: "unsupported_composition" });
    expect(f.parent.postMessage.mock.calls.length).toBe(count);
  });
  it("rejects inactive calls without I/O and requires a fresh handshake after renewal", async () => {
    const f = await connect(); child!.setActive(false);
    const calls = fetcher.mock.calls.length, posts = f.parent.postMessage.mock.calls.length;
    const requestId = createPresentationRequestId();
    expect(await child!.openSurface(target, { placement: "side", requestId })).toMatchObject({ status: "blocked", code: "activity_required" });
    expect(await child!.getPresentation(requestId)).toMatchObject({ status: "blocked", code: "activity_required" });
    window.dispatchEvent(new Event("focus"));
    child!.reportSurfaceState({ route: "/panel", state: "ready" }); f.send(f.offer);
    expect(fetcher).toHaveBeenCalledTimes(calls); expect(f.parent.postMessage).toHaveBeenCalledTimes(posts);
    child!.setActive(true);
    f.send({ ...f.offer, type: "hosty:ui:connected", coreOrigin: metadata.coreOrigin, userId: metadata.userId, appId: "host", installationId: "host-1" });
    expect(child!.getEnvironment().connection).toBe("connecting");
    expect(await child!.openSurface(target, { placement: "side", requestId })).toMatchObject({ code: "host_unavailable" });
    const offer = await reconnect(f);
    expect(offer.childNonce).not.toBe(f.offer.childNonce);
    expect(child!.getEnvironment().connection).toBe("connected");
  });
  it("blocks an unsent request when deactivated during revalidation", async () => {
    const f = await connect();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    fetcher.mockImplementation(async () => { await gate; return Response.json(metadata); });
    const opening = child!.openSurface(target, { placement: "side", requestId: createPresentationRequestId() });
    child!.setActive(false);
    expect(await opening).toMatchObject({ status: "blocked", code: "activity_required" });
    release(); await Promise.resolve(); await Promise.resolve();
    expect(f.parent.postMessage.mock.calls.filter(([msg]) => msg.type === "hosty:ui:open")).toHaveLength(0);
    expect(child!.getEnvironment()).toMatchObject({ connection: "blocked", code: "activity_required" });
  });
  it("marks dispatched work uncertain and ignores old replies after renewal", async () => {
    const f = await connect(), requestId = createPresentationRequestId();
    const opening = child!.openSurface(target, { placement: "side", requestId });
    await vi.waitFor(() => expect(f.parent.postMessage.mock.calls.at(-1)![0].type).toBe("hosty:ui:open"));
    child!.setActive(false);
    expect(await opening).toMatchObject({ status: "uncertain", code: "presentation_unknown" });
    const offer = await reconnect(f), settled = vi.fn();
    const retry = child!.openSurface(target, { placement: "side", requestId }).then(settled);
    await vi.waitFor(() => expect(f.parent.postMessage.mock.calls.at(-1)![0].type).toBe("hosty:ui:open"));
    const result = { status: "opened", requestId, target, readiness: "ready" };
    f.send({ ...f.offer, type: "hosty:ui:result", requestId, result }); await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    f.send({ ...offer, type: "hosty:ui:result", requestId, result }); await retry;
    expect(settled).toHaveBeenCalledWith(result);
  });
  it.each(["success", "failure"])("ignores stale verification %s from before activity renewal", async outcome => {
    const f = begin();
    let finish!: (value: Response) => void, reject!: (cause: Error) => void;
    fetcher.mockImplementationOnce(() => new Promise<Response>((resolve, fail) => { finish = resolve; reject = fail; }));
    f.send(f.offer); child!.setActive(false);
    const offer = await reconnect(f);
    if (outcome === "success") finish(Response.json(metadata)); else reject(new Error("Old failure"));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(child!.getEnvironment().connection).toBe("connected");
    const accepts = f.parent.postMessage.mock.calls.filter(([msg]) => msg.type === "hosty:ui:accept");
    expect(accepts).toHaveLength(1); expect(accepts[0][0].childNonce).toBe(offer.childNonce);
  });
  it("rejects conflicting request identities before asynchronous verification completes", async () => {
    const f = await connect(), requestId = createPresentationRequestId();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    fetcher.mockImplementation(async () => { await gate; return Response.json(metadata); });
    const first = child!.openSurface(target, { placement: "side", requestId });
    expect(await child!.openSurface({ ...target, route: "/assistant?session=other" }, { placement: "side", requestId }))
      .toEqual({ status: "rejected", requestId, code: "request_conflict" });
    expect(f.parent.postMessage.mock.calls.filter(([msg]) => msg.type === "hosty:ui:open")).toHaveLength(0);
    release();
    await vi.waitFor(() => expect(f.parent.postMessage.mock.calls.filter(([msg]) => msg.type === "hosty:ui:open")).toHaveLength(1));
    f.send({ ...f.offer, type: "hosty:ui:result", requestId, result: { status: "opened", requestId, target, readiness: "loading" } });
    expect(await first).toMatchObject({ status: "opened", target });
  });
  it("coalesces identical openings and status while preserving independent aborted waits", async () => {
    const f = await connect(), requestId = createPresentationRequestId(), abort = new AbortController();
    const first = child!.openSurface(target, { placement: "side", requestId, signal: abort.signal });
    const second = child!.openSurface({ ...target }, { placement: "side", requestId });
    const status = child!.getPresentation(requestId);
    await vi.waitFor(() => expect(f.parent.postMessage.mock.calls.filter(([msg]) => msg.type === "hosty:ui:open")).toHaveLength(1));
    abort.abort(); expect(await first).toMatchObject({ status: "uncertain" });
    f.send({ ...f.offer, type: "hosty:ui:result", requestId, result: { status: "opened", requestId, target, readiness: "ready" } });
    expect(await second).toMatchObject({ status: "opened", readiness: "ready" });
    expect(await status).toMatchObject({ status: "opened", readiness: "ready" });
    expect(f.parent.postMessage.mock.calls.filter(([msg]) => msg.type === "hosty:ui:status")).toHaveLength(0);
  });
  it("does not satisfy a later opening with an earlier status query's unknown result", async () => {
    const f = await connect(), requestId = createPresentationRequestId();
    const status = child!.getPresentation(requestId);
    const opening = child!.openSurface(target, { placement: "side", requestId });
    await vi.waitFor(() => expect(f.parent.postMessage.mock.calls.at(-1)![0].type).toBe("hosty:ui:status"));
    f.send({ ...f.offer, type: "hosty:ui:result", requestId, result: { status: "unknown", requestId, code: "presentation_unknown" } });
    expect(await status).toMatchObject({ status: "unknown" });
    await vi.waitFor(() => expect(f.parent.postMessage.mock.calls.at(-1)![0].type).toBe("hosty:ui:open"));
    f.send({ ...f.offer, type: "hosty:ui:result", requestId, result: { status: "opened", requestId, target, readiness: "ready" } });
    expect(await opening).toMatchObject({ status: "opened" });
  });
  it.each(["abort", "timeout"])("keeps a sent status reservation after its waiter ends by %s", async reason => {
    const f = await connect(), requestId = createPresentationRequestId(), abort = new AbortController();
    vi.useFakeTimers();
    const status = child!.getPresentation(requestId, { signal: abort.signal });
    await vi.waitFor(() => expect(f.parent.postMessage.mock.calls.at(-1)![0].type).toBe("hosty:ui:status"));
    if (reason === "abort") abort.abort(); else await vi.advanceTimersByTimeAsync(10_001);
    expect(await status).toMatchObject({ status: "uncertain" });
    const settled = vi.fn(), opening = child!.openSurface(target, { placement: "side", requestId }).then(settled);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.parent.postMessage.mock.calls.filter(([msg]) => msg.type === "hosty:ui:open")).toHaveLength(0);
    f.send({ ...f.offer, type: "hosty:ui:result", requestId, result: { status: "unknown", requestId, code: "presentation_unknown" } });
    await vi.waitFor(() => expect(f.parent.postMessage.mock.calls.at(-1)![0].type).toBe("hosty:ui:open"));
    expect(settled).not.toHaveBeenCalled();
    const result = { status: "opened", requestId, target, readiness: "ready" };
    f.send({ ...f.offer, type: "hosty:ui:result", requestId, result }); await opening;
    expect(settled).toHaveBeenCalledWith(result);
  });
  it("ends an opening's timed-out wait behind a lost status without dispatching it later", async () => {
    const f = await connect(), requestId = createPresentationRequestId(), abort = new AbortController();
    vi.useFakeTimers();
    const status = child!.getPresentation(requestId, { signal: abort.signal });
    await vi.waitFor(() => expect(f.parent.postMessage.mock.calls.at(-1)![0].type).toBe("hosty:ui:status"));
    abort.abort(); await status;
    const settled = vi.fn(), opening = child!.openSurface(target, { placement: "side", requestId }).then(settled);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(settled).toHaveBeenCalledWith({ status: "uncertain", requestId, code: "presentation_unknown" });
    await opening;
    f.send({ ...f.offer, type: "hosty:ui:result", requestId, result: { status: "unknown", requestId, code: "presentation_unknown" } });
    await vi.advanceTimersByTimeAsync(10_001);
    expect(f.parent.postMessage.mock.calls.filter(([msg]) => msg.type === "hosty:ui:open")).toHaveLength(0);
    const retry = child!.openSurface(target, { placement: "side", requestId });
    await vi.waitFor(() => expect(f.parent.postMessage.mock.calls.at(-1)![0].type).toBe("hosty:ui:open"));
    f.send({ ...f.offer, type: "hosty:ui:result", requestId, result: { status: "opened", requestId, target, readiness: "ready" } });
    expect(await retry).toMatchObject({ status: "opened" });
  });
  it.each(["probe", "offer"])("retires lost reservations on a fresh host generation announced by %s", async announcement => {
    const f = await connect(), requestId = createPresentationRequestId(), abort = new AbortController();
    const status = child!.getPresentation(requestId, { signal: abort.signal });
    await vi.waitFor(() => expect(f.parent.postMessage.mock.calls.at(-1)![0].type).toBe("hosty:ui:status"));
    abort.abort(); await status;
    const offer = { ...f.offer, generation: createPresentationRequestId() };
    if (announcement === "probe") f.send({ ...offer, type: "hosty:ui:probe-request" });
    f.send(offer);
    await vi.waitFor(() => expect(f.parent.postMessage.mock.calls.at(-1)![0]).toMatchObject({ type: "hosty:ui:accept", generation: offer.generation }));
    f.send({ ...offer, type: "hosty:ui:connected", coreOrigin: metadata.coreOrigin, userId: metadata.userId, appId: "host", installationId: "host-1" });
    const settled = vi.fn(), opening = child!.openSurface(target, { placement: "side", requestId }).then(settled);
    await vi.waitFor(() => expect(f.parent.postMessage.mock.calls.at(-1)![0].type).toBe("hosty:ui:open"));
    f.send({ ...f.offer, type: "hosty:ui:result", requestId, result: { status: "unknown", requestId, code: "presentation_unknown" } });
    await Promise.resolve(); expect(settled).not.toHaveBeenCalled();
    const result = { status: "opened", requestId, target, readiness: "ready" };
    f.send({ ...offer, type: "hosty:ui:result", requestId, result }); await opening;
    expect(settled).toHaveBeenCalledWith(result);
  });
  it("discovers without identity, verifies the observed parent and uses exact-origin messages", async () => {
    const f = await connect();
    expect(Object.keys(f.probe).sort()).toEqual(["capabilities", "childNonce", "type", "version", "versions"]);
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

describe("composition presentation instances", () => {
  it.each([false, true])("replays the accepted presentation after navigation (different endpoint: %s)", async differentEndpoint => {
    const h = await start(), requestId = createPresentationRequestId();
    const opened = await h.openSurface(target, { placement: "side", requestId });
    expect(opened.status).toBe("opened"); if (opened.status !== "opened") return;
    const next = { ...resolved.surface!, route: "/people",
      ...(differentEndpoint ? { endpoint: "other", origin: "https://other.test" } : {}) };
    const f = frame(resolved.surface!, { viewId: "tool-view", workspaceId: "default", presentationId: opened.presentationId, navigate: vi.fn() });
    f.send({ type: "hosty:ui:probe", childNonce: f.offer.childNonce, versions: [1], capabilities: ["ui.composition.v1"] });
    f.send({ ...f.offer, type: "hosty:ui:accept", coreOrigin: metadata.coreOrigin, userId: metadata.userId, appId: panel.appId, installationId: panel.installationId });
    fetcher.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.endsWith("panels/resolve") && JSON.parse(init!.body as string).route !== target.route)
        return Response.json({ code: "destination_invalid" }, { status: 400 });
      return Response.json(path.endsWith("navigation/resolve") ? { available: true, surface: next, state: "running" }
        : path.endsWith("panels/resolve") ? resolution : metadata);
    });
    f.send({ ...f.offer, type: "hosty:ui:navigate", requestId: createPresentationRequestId(), entryKey: "entry" });
    await vi.waitFor(() => expect(h.getSnapshot().tools[0]!.resolved.surface).toEqual(next));
    expect(await h.getPresentation(requestId)).toMatchObject({ status: "opened", presentationId: opened.presentationId, target });
    h.setExpanded(false);
    expect(await h.openSurface(target, { placement: "side", requestId })).toMatchObject({ status: "opened", presentationId: opened.presentationId });
    expect(h.getSnapshot().expanded).toBe(true); expect(h.getSnapshot().tools).toHaveLength(1);
    expect(h.getSnapshot().tools[0]!.resolved.surface).toEqual(next);
    h.setExpanded(false);
    expect(await h.selectPanel(panel)).toMatchObject({ status: "opened", presentationId: opened.presentationId });
    expect(h.getSnapshot().expanded).toBe(true); expect(h.getSnapshot().tools[0]!.resolved.surface).toEqual(next);
    resolution = { ...resolution, surface: { ...resolution.surface!, origin: "https://replaced.test" } };
    expect(await h.getPresentation(requestId)).toMatchObject({ status: "blocked", code: "destination_changed" });
    resolution = { ...resolved, available: false, state: "access_unavailable" };
    expect(await h.openSurface(target, { placement: "side", requestId })).toMatchObject({ status: "blocked", code: "access_unavailable" });
  });
  it("binds navigation to the registered app view, synchronizes its host adapter and replays once", async () => {
    await start(); const navigate = vi.fn();
    const f = frame(resolved.surface!, { viewId: "app-window", workspaceId: "default", navigate });
    f.send({ type: "hosty:ui:probe", childNonce: f.offer.childNonce, versions: [1], capabilities: ["ui.composition.v1"] });
    f.send({ ...f.offer, type: "hosty:ui:accept", coreOrigin: metadata.coreOrigin, userId: metadata.userId, appId: panel.appId, installationId: panel.installationId });
    const next = { ...resolved.surface!, endpoint: "other", origin: "https://other.test", route: "/people" };
    fetcher.mockImplementation(async (path: string) => Response.json(path.endsWith("navigation/resolve") ? { available: true, surface: next, state: "running" } : metadata));
    const requestId = createPresentationRequestId(), message = { ...f.offer, type: "hosty:ui:navigate", requestId, entryKey: "entry", appId: "forged", installationId: "forged" };
    f.send(message); await vi.waitFor(() => expect(navigate).toHaveBeenCalledOnce());
    expect(navigate).toHaveBeenCalledWith(next);
    expect(JSON.parse(fetcher.mock.calls.find(([path]) => path.endsWith("navigation/resolve"))![1].body)).toEqual({ appId: panel.appId, installationId: panel.installationId, entryKey: "entry" });
    f.send(message); await vi.waitFor(() => expect(f.post.mock.calls.filter(([m]) => m.type === "hosty:ui:action-result")).toHaveLength(2));
    expect(navigate).toHaveBeenCalledOnce();
  });
  it("retires pending requests from a closed source while preserving shared presentations", async () => {
    const h = await start(); await h.openSurface(target, { placement: "side", requestId: createPresentationRequestId() });
    const retained = h.getSnapshot().tools[0]!.presentationId, f = frame();
    let finish!: (value: Response) => void;
    fetcher.mockImplementation(async (path: string) => path.endsWith("resolve") ? new Promise<Response>(resolve => { finish = resolve; }) : Response.json(metadata));
    const requestId = createPresentationRequestId();
    f.send({ ...f.offer, type: "hosty:ui:open", requestId, target: { ...target, route: "/assistant?session=pending" }, placement: "side" });
    await vi.waitFor(() => expect(finish).toBeDefined()); f.release(); finish(Response.json(resolved));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(h.getSnapshot().tools.map(t => t.presentationId)).toEqual([retained]);
    expect(f.post.mock.calls.some(([m]) => m.type === "hosty:ui:result" && m.requestId === requestId)).toBe(false);
  });
  it("retains different conversations, reuses the exact route and never resurrects a closed request", async () => {
    const h = await start(), firstId = createPresentationRequestId();
    const first = await h.openSurface(target, { placement: "side", requestId: firstId });
    expect(first.status).toBe("opened"); if (first.status !== "opened") return;
    const next = { ...target, route: "/assistant?session=other" };
    resolution = { ...resolved, target: next, surface: { ...resolved.surface!, route: next.route } };
    const second = await h.openSurface(next, { placement: "side", requestId: createPresentationRequestId() });
    expect(second).toMatchObject({ status: "opened" }); expect(h.getSnapshot().tools).toHaveLength(2);
    resolution = structuredClone(resolved);
    expect(await h.openSurface(target, { placement: "side", requestId: createPresentationRequestId() })).toMatchObject({ presentationId: first.presentationId });
    const duplicate = await h.openSurface(target, { placement: "side", requestId: createPresentationRequestId(), reuse: "new" });
    expect(duplicate).not.toMatchObject({ presentationId: first.presentationId }); expect(h.getSnapshot().tools).toHaveLength(3);
    h.closePresentation(first.presentationId!);
    expect(await h.openSurface(target, { placement: "side", requestId: firstId })).toMatchObject({ status: "opened", presentationId: first.presentationId });
    expect(h.getSnapshot().tools).toHaveLength(2);
  });
  it("isolates workspace supersession and rejects disabled source requests without deleting retained tools", async () => {
    const h = await start();
    h.registerWorkspace({ workspaceId: "second", renderer: { present: async () => "accepted", focus() {}, collapse() {}, release() {}, showToolPicker: async () => "accepted" } });
    h.setPlacementResolver(({ target }) => ({ workspaceId: target.route?.includes("other") ? "second" : "default" }));
    let finish!: (value: Response) => void;
    fetcher.mockImplementation(async (path: string, init?: RequestInit) => {
      if (!path.endsWith("resolve")) return Response.json(path.endsWith("bootstrap") ? metadata : { panels });
      const requested = JSON.parse(init!.body as string);
      if (requested.route === target.route) return new Promise<Response>(resolve => { finish = resolve; });
      return Response.json({ ...resolved, target: requested, surface: { ...resolved.surface!, route: requested.route } });
    });
    const pending = h.openSurface(target, { placement: "side", requestId: createPresentationRequestId() });
    await vi.waitFor(() => expect(finish).toBeDefined());
    const other = await h.openSurface({ ...target, route: "/assistant?session=other" }, { placement: "side", requestId: createPresentationRequestId() });
    h.collapseWorkspace("default"); finish(Response.json(resolved));
    expect(await pending).toMatchObject({ code: "presentation_superseded" });
    expect(other.status).toBe("opened"); expect(h.getSnapshot().workspaces?.find(w => w.workspaceId === "second")?.expanded).toBe(true);
    h.setViewChrome("root", { tools: { enabled: false } });
    expect(h.getSnapshot().tools).toHaveLength(1);
    expect(await h.openSurface(target, { placement: "side", requestId: createPresentationRequestId() })).toMatchObject({ code: "tools_disabled" });
    h.setViewChrome("root", {});
    expect(h.getSnapshot().workspaces?.every(w => !w.expanded)).toBe(true);
  });
  it("moves only between renderers sharing a retained frame layer", async () => {
    const h = await start(), layer = {}, next = vi.fn(async () => "accepted" as const);
    // A separately registered default renderer is rejected, so use a fresh host for this fixture.
    h.dispose(); host = createUiHost(); const current = host;
    const renderer = { frameLayer: layer, present: next, focus() {}, collapse() {}, release() {}, showToolPicker: async () => "accepted" as const };
    current.registerWorkspace({ workspaceId: "default", renderer });
    current.registerWorkspace({ workspaceId: "floating", renderer: { ...renderer } });
    current.registerWorkspace({ workspaceId: "foreign-layer", renderer: { ...renderer, frameLayer: {} } });
    await current.refresh();
    const result = await current.openSurface(target, { placement: "side", requestId: createPresentationRequestId() });
    if (result.status !== "opened") throw new Error(result.code);
    expect(await current.movePresentation(result.presentationId!, "foreign-layer")).toBe(false);
    expect(await current.movePresentation(result.presentationId!, "floating")).toBe(true);
    expect(current.getSnapshot().tools[0]).toMatchObject({ presentationId: result.presentationId, workspaceId: "floating" });
  });
  it.each(["superseded", "refused", "closed"])("restores external renderer placement after a %s pending move", async outcome => {
    host = createUiHost(); const h = host, layer = {}, frames = new Map<string, HTMLIFrameElement>();
    let finish!: (result: "accepted" | "unavailable") => void, signal!: AbortSignal;
    const present = async (tool: { presentationId: string; workspaceId: string }) => {
      let frame = frames.get(tool.presentationId);
      if (!frame) { frame = document.createElement("iframe"); document.body.append(frame); frames.set(tool.presentationId, frame); }
      frame.dataset.workspace = tool.workspaceId;
      return "accepted" as const;
    };
    const renderer = { frameLayer: layer, present, focus: vi.fn(), collapse: vi.fn(), showToolPicker: async () => "accepted" as const,
      release(id: string) { frames.get(id)?.remove(); frames.delete(id); } };
    h.registerWorkspace({ workspaceId: "default", renderer });
    h.registerWorkspace({ workspaceId: "floating", renderer: { ...renderer, present: async (tool, abort) => {
      await present(tool); signal = abort;
      return new Promise(resolve => { finish = resolve; });
    } } });
    await h.refresh();
    const opened = await h.openSurface(target, { placement: "side", requestId: createPresentationRequestId() });
    if (opened.status !== "opened") throw new Error(opened.code);
    const id = opened.presentationId!, frame = frames.get(id)!, context = frame.contentWindow;
    const moving = h.movePresentation(id, "floating");
    await vi.waitFor(() => expect(finish).toBeDefined());
    expect(frame.dataset.workspace).toBe("floating");
    expect(await h.movePresentation(id, "floating")).toBe(false);
    if (outcome === "closed") h.closePresentation(id);
    else if (outcome === "superseded") h.collapseWorkspace("floating");
    if (outcome !== "refused") expect(signal.aborted).toBe(true);
    finish(outcome === "refused" ? "unavailable" : "accepted");
    expect(await moving).toBe(false);
    if (outcome === "closed") {
      expect(frames.size).toBe(0); expect(frame.isConnected).toBe(false); expect(h.getSnapshot().tools).toHaveLength(0);
    } else {
      expect(h.getSnapshot().tools[0]!.workspaceId).toBe("default"); expect(frame.dataset.workspace).toBe("default");
      expect(frame.contentWindow).toBe(context); expect(renderer.focus).toHaveBeenLastCalledWith(id);
    }
  });
  it("does not acknowledge an absent renderer or retarget a preferred mismatching instance", async () => {
    host = createUiHost(); await host.refresh();
    expect(await host.openSurface(target, { placement: "side", requestId: createPresentationRequestId() })).toMatchObject({ code: "presentation_unavailable" });
    host.dispose(); const h = await start();
    const first = await h.openSurface(target, { placement: "side", requestId: createPresentationRequestId() });
    if (first.status !== "opened") throw new Error(first.code);
    h.setPlacementResolver(() => ({ workspaceId: "default", presentationId: first.presentationId }));
    const other = { ...target, route: "/assistant?session=other" };
    resolution = { ...resolved, target: other, surface: { ...resolved.surface!, route: other.route } };
    expect(await h.openSurface(other, { placement: "side", requestId: createPresentationRequestId() })).toMatchObject({ code: "destination_changed" });
    expect(h.getSnapshot().tools[0]?.target).toEqual(target);
  });
  it("keeps chooser and presentation request IDs in one conflict namespace", async () => {
    const h = await start(), requestId = createPresentationRequestId();
    expect(await h.openToolPicker({ requestId })).toMatchObject({ status: "accepted" });
    expect(await h.openSurface(target, { placement: "side", requestId })).toMatchObject({ code: "request_conflict" });
    expect(await h.openToolPicker({ requestId })).toMatchObject({ status: "accepted" });
  });
});
