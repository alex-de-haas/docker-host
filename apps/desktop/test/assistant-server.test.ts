// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ mutation: vi.fn(), proxy: vi.fn(), assistant: vi.fn(), prepare: vi.fn(), finalize: vi.fn(), list: vi.fn() }));
vi.mock("../src/lib/core-proxy", () => ({ requireDesktopMutation: mocks.mutation, proxyCore: mocks.proxy }));
vi.mock("@hosty-sdk/app/ui/server", () => ({ UiServerClient: class { bootstrap = async () => ({ pinnedOpen: true }); } }));
vi.mock("@hosty-sdk/app/providers/server", () => ({ ProviderClient: class { assistant = mocks.assistant; list = mocks.list; } }));
import { createWindowDiscussion } from "../src/lib/assistant-server";
const input = { providerAppId: "helper", installationId: "install-a", key: "default", contextAppId: "notes", contextInstallationId: "notes-1", requestId: "019a2190-1234-7123-8123-012345678901" };
const call = (body = input) => createWindowDiscussion(new Request("https://desktop.example/api/assistant/discussion", { method: "POST", body: JSON.stringify(body) }));
beforeEach(() => {
  vi.clearAllMocks(); mocks.mutation.mockReturnValue({ token: "actor-token" });
  mocks.proxy.mockImplementation(async (_request, path: string[]) => Response.json(path.includes("session") ? { user: { id: "alice", role: "host.user" } } : { apps: [{ id: "notes", installationId: "notes-1", displayName: "Notes", runtimeState: "running", entryEndpoint: "web" }] }));
  mocks.assistant.mockResolvedValue({ prepare: mocks.prepare, finalize: mocks.finalize });
  mocks.prepare.mockResolvedValue({ handoffId: "handoff-1" });
  mocks.finalize.mockResolvedValue({ conversationId: "conversation-1", result: { disposition: "draft", conversationId: "conversation-1", open: { endpoint: "web", path: "/chat/conversation-1", panelId: "chat" } } });
  mocks.list.mockResolvedValue([{ appId: "helper", installationId: "install-a", key: "default", kind: "assistant", uiSurfaces: [{ kind: "panel", endpoint: "web", path: "/chat", url: "https://helper.example/chat", panelId: "chat" }] }]);
});
afterEach(() => vi.unstubAllEnvs());
it("pins delegation to the installation and creates only an empty draft with the available source app", async () => {
  const response = await call({ ...input, prompt: "untrusted instruction" } as typeof input);
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ target: { panel: { appId: "helper", installationId: "install-a", panelId: "chat" }, route: "/chat/conversation-1" } });
  expect(mocks.prepare).toHaveBeenCalledWith({ requestId: input.requestId, prompt: "", appIds: ["notes"] });
  expect(mocks.finalize).toHaveBeenCalledWith("handoff-1", []);
  expect(mocks.assistant.mock.calls[0][0]).toEqual({ appId: "helper", installationId: "install-a", key: "default" });
  expect(await mocks.assistant.mock.calls[0][1]()).toBe("actor-token");
});
it("preserves the mutation guard and rejects inaccessible context before contacting a provider", async () => {
  mocks.mutation.mockReturnValueOnce(new Response(null, { status: 403 })); expect((await call()).status).toBe(403);
  expect((await call({ ...input, contextAppId: "unassigned" })).status).toBe(403);
  expect((await call({ ...input, contextInstallationId: "old-notes" })).status).toBe(403);
  expect(mocks.assistant).not.toHaveBeenCalled();
});
it("rejects stale assistant installations and destinations outside their declared panel", async () => {
  mocks.list.mockResolvedValueOnce([{ appId: "helper", installationId: "replacement", key: "default", uiSurfaces: [] }]);
  expect((await call()).status).not.toBe(200);
  mocks.finalize.mockResolvedValueOnce({ result: { disposition: "draft", open: { endpoint: "other", path: "/elsewhere" } } });
  expect((await call()).status).not.toBe(200);
});
it("rejects malformed input and repeats the same request identity during recovery", async () => {
  expect((await call({ ...input, requestId: "bad" })).status).toBe(400); expect(mocks.prepare).not.toHaveBeenCalled();
  await call(); await call(); expect(mocks.prepare.mock.calls[0]).toEqual(mocks.prepare.mock.calls[1]);
});
