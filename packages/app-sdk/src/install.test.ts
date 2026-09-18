import { describe, expect, it, vi } from "vitest";
import { createInstallationClient, InstallationFlow, type InstallationClient, type InstallationRequest } from "./install";

const draft: InstallationRequest = { id: "a".repeat(48), status: "draft", plan: null,
  approvalUrl: "https://core.example/install/confirm/test", expiresAt: "2099-01-01T00:00:00Z" };
function client(): InstallationClient {
  return { prepare: vi.fn(async () => draft), submit: vi.fn(async () => ({ ...draft, status: "pending" })), status: vi.fn(async () => draft) };
}

describe("installation client", () => {
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
