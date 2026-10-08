import { describe, expect, it, vi } from "vitest";
import { createInstallationClient, InstallationError, InstallationFlow, type InstallationClient, type InstallationRequest } from "./install";

const draft: InstallationRequest = { id: "a".repeat(48), status: "draft", plan: null,
  approvalUrl: "https://core.example/install/confirm/test", expiresAt: "2099-01-01T00:00:00Z" };
function client(): InstallationClient {
  return { prepare: vi.fn(async () => draft), submit: vi.fn(async () => ({ ...draft, status: "pending" })), status: vi.fn(async () => draft) };
}

describe("installation client", () => {
  it("leaves installation choices to Core when submitting defaults", async () => {
    const request = vi.fn(async () => Response.json(draft));
    const api = createInstallationClient({ request });
    await api.prepare({ feedsUrl: "https://apps.example/feeds.json" });
    await api.submit(draft.id);
    expect(request.mock.calls[0][1]).toEqual({ feedsUrl: "https://apps.example/feeds.json" });
    expect(JSON.stringify(request.mock.calls[1][1])).toBe("{}");
  });
  it("prepares removal with explicit cleanup options through the Core approval flow", async () => {
    const request = vi.fn(async () => Response.json(draft));
    const source = { removeAppId: "example.app", removalOptions: { deleteData: true, deleteBackups: false } };
    await createInstallationClient({ request }).prepare(source);
    expect(request).toHaveBeenCalledExactlyOnceWith("/api/hosty/installations", source, "POST");
  });
  it("submits settings without accepting optional permission choices", async () => {
    const request = vi.fn(async () => Response.json(draft));
    const api = createInstallationClient({ request });
    // Old JavaScript callers may still pass the removed fourth argument; it must not be sent.
    await Reflect.apply(api.submit, api, [draft.id, {}, false, ["providers.speech-to-text"]]);
    expect(request).toHaveBeenCalledExactlyOnceWith(`/api/hosty/installations/${draft.id}/submit`, {
      settings: {}, autostart: false,
    }, "POST");
  });
  it("uses request/submit/status only and preserves settings without an apply endpoint", async () => {
    const request = vi.fn(async () => Response.json(draft));
    const api = createInstallationClient({ request });
    await api.prepare({ feedsUrl: "https://apps.example/feeds.json", feedId: "stable" });
    await api.submit(draft.id, { PASSWORD: "secret" }, false);
    await api.status(draft.id);
    expect(request.mock.calls).toEqual([
      ["/api/hosty/installations", { feedsUrl: "https://apps.example/feeds.json", feedId: "stable" }, "POST"],
      [`/api/hosty/installations/${draft.id}/submit`, { settings: { PASSWORD: "secret" }, autostart: false }, "POST"],
      [`/api/hosty/installations/${draft.id}`, undefined, "GET"],
    ]);
  });
  it("preserves permission errors without retrying the mutation", async () => {
    const request = vi.fn(async () => Response.json({ code: "app_permission_required", message: "Permission missing" }, { status: 403 }));
    await expect(createInstallationClient({ request }).prepare({ manifestPath: "app.json" })).rejects.toMatchObject({ status: 403, code: "app_permission_required" });
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("installation flow", () => {
  it.each(["succeeded", "denied", "failed"] as const)("allows a new explicit review after a known %s outcome", async status => {
    const api = client(); const flow = new InstallationFlow(api);
    vi.mocked(api.submit).mockResolvedValueOnce({ ...draft, status });
    await flow.review({ updateAppId: "example.app", sourceConnections: { manifestConnectionId: "old" } });
    await flow.submit();
    flow.clearReview();
    expect(flow.snapshot().request).toBeNull();
    const source = { updateAppId: "example.app", sourceConnections: { manifestConnectionId: "new" } };
    await flow.review(source);
    expect(api.prepare).toHaveBeenLastCalledWith(source);
    expect(api.submit).toHaveBeenCalledTimes(1);
  });
  it("does not clear a request executing in Core", async () => {
    const api = client(); const flow = new InstallationFlow(api);
    vi.mocked(api.submit).mockResolvedValueOnce({ ...draft, status: "executing" });
    await flow.review({ manifestPath: "app.json" });
    await flow.submit(); flow.clearReview();
    await flow.review({ manifestPath: "other.json" });
    expect(flow.snapshot().request?.status).toBe("executing");
    expect(api.prepare).toHaveBeenCalledTimes(1);
  });
  it("ignores a stale review after a newer runtime selection", async () => {
    const api = client();
    let first!: (request: InstallationRequest) => void;
    vi.mocked(api.prepare).mockImplementationOnce(() => new Promise(resolve => { first = resolve; }));
    const flow = new InstallationFlow(api);
    const old = flow.review({ manifestPath: "app.json" });
    await flow.review({ manifestPath: "app.json", selectedRuntime: "dev" });
    first({ ...draft, id: "old" });
    await old;
    expect(flow.snapshot().request?.id).toBe(draft.id);
  });
  it("does not submit twice or permit replanning a pending approval", async () => {
    const api = client();
    const flow = new InstallationFlow(api);
    await flow.review({ manifestPath: "app.json" });
    await Promise.all([flow.submit({}, true), flow.submit({}, true)]);
    await flow.review({ manifestPath: "other.json" });
    expect(api.submit).toHaveBeenCalledTimes(1);
    expect(api.prepare).toHaveBeenCalledTimes(1);
    expect(flow.snapshot().request?.status).toBe("pending");
  });
  it("does not replace an identity while its submission is in flight", async () => {
    const api = client(); let finish!: (request: InstallationRequest) => void;
    vi.mocked(api.submit).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const flow = new InstallationFlow(api);
    await flow.review({ feedsUrl: "https://apps.example/feeds.json", feedId: "beta" });
    const submitting = flow.submit();
    flow.clearReview();
    await flow.review({ manifestPath: "different.json" });
    finish({ ...draft, status: "pending" });
    await submitting;
    expect(api.prepare).toHaveBeenCalledTimes(1);
    expect(flow.snapshot().request).toMatchObject({ id: draft.id, status: "pending" });
  });
  it("recovers a lost submit response by reading status, without another mutation", async () => {
    const api = client();
    vi.mocked(api.submit).mockRejectedValue(new Error("connection lost"));
    vi.mocked(api.status).mockResolvedValue({ ...draft, status: "pending" });
    const flow = new InstallationFlow(api);
    await flow.review({ manifestPath: "app.json" });
    expect((await flow.submit({}, false))?.status).toBe("pending");
    expect(api.submit).toHaveBeenCalledTimes(1);
    expect(api.status).toHaveBeenCalledTimes(1);
    expect(flow.snapshot().error).toBeNull();
  });
  it("reports a definitive submit authorization refusal without uncertain recovery", async () => {
    const api = client();
    vi.mocked(api.submit).mockRejectedValue(new InstallationError("Authentication required", 401));
    const flow = new InstallationFlow(api);
    await flow.review({ manifestPath: "app.json" });
    expect(await flow.submit()).toBeNull();
    expect(flow.snapshot()).toMatchObject({ uncertainSubmit: false, error: "Authentication required" });
    expect(api.status).not.toHaveBeenCalled();
    expect(api.submit).toHaveBeenCalledTimes(1);
  });
  it("keeps an uncertain submit identity until its status can be read", async () => {
    const api = client();
    vi.mocked(api.submit).mockRejectedValue(new Error("connection lost"));
    vi.mocked(api.status).mockRejectedValue(new Error("Core unavailable"));
    const flow = new InstallationFlow(api);
    await flow.review({ feedsUrl: "https://apps.example/feeds.json", feedId: "beta" });
    await flow.submit();
    expect(flow.snapshot().uncertainSubmit).toBe(true);
    flow.clearReview();
    await flow.review({ feedsUrl: "https://other.example/feeds.json" });
    await flow.submit();
    expect(flow.snapshot().request?.id).toBe(draft.id);
    expect(api.prepare).toHaveBeenCalledTimes(1);
    expect(api.submit).toHaveBeenCalledTimes(1);
    vi.mocked(api.status).mockResolvedValue({ ...draft, status: "pending" });
    await flow.refresh();
    expect(api.status).toHaveBeenLastCalledWith(draft.id);
    expect(flow.snapshot()).toMatchObject({ uncertainSubmit: false, error: null, request: { status: "pending" } });
  });
  it("allows retrying the same draft only after Core resolves an uncertain submit", async () => {
    const api = client();
    vi.mocked(api.submit).mockRejectedValueOnce(new Error("connection lost"));
    vi.mocked(api.status).mockRejectedValueOnce(new Error("Core unavailable"));
    const flow = new InstallationFlow(api);
    await flow.review({ manifestPath: "app.json" });
    await flow.submit();
    await flow.refresh();
    await flow.submit({ API_KEY: "configured" }, false);
    expect(api.prepare).toHaveBeenCalledTimes(1);
    expect(api.submit).toHaveBeenLastCalledWith(draft.id, { API_KEY: "configured" }, false);
  });
  it("ignores a request that resolves after the UI closes", async () => {
    const api = client();
    let resolve!: (request: InstallationRequest) => void;
    vi.mocked(api.prepare).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const flow = new InstallationFlow(api);
    const pending = flow.review({ manifestPath: "app.json" });
    flow.cancelPending();
    resolve(draft);
    await pending;
    expect(flow.snapshot().request).toBeNull();
  });
});
