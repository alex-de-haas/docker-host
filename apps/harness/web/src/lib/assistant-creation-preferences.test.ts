import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { appFetch } from "@hosty-sdk/app/browser-auth";
import { createSession, createWorkspaceSession, newBuildingSession } from "./assistant-api";
import { loadBrowserAgentDefaults } from "./browser-agent-preferences";

vi.mock("@hosty-sdk/app/browser-auth", () => ({ appFetch: vi.fn(), APP_SESSION_RESTORED: "restored" }));
vi.mock("./browser-agent-preferences", () => ({ loadBrowserAgentDefaults: vi.fn() }));
const defaults = { models: { account: { model: "model", reasoningEffort: "high" } }, autonomy: "autonomous" as const };
beforeEach(() => {
  vi.mocked(appFetch).mockImplementation(async () => Response.json({ id: "created", createdBy: "owner" }));
  vi.mocked(loadBrowserAgentDefaults).mockResolvedValue(defaults);
});
afterEach(() => vi.resetAllMocks());

it.each([
  ["ordinary", () => createSession({ clientRequestId: "request" }), "/api/sessions"],
  ["workspace", () => createWorkspaceSession({ workspaceId: "workspace", requestId: "request", expectedRevision: 2 }), "/api/workspace-sessions"],
  ["building", () => newBuildingSession({ appId: "app", requestId: "request", expectedLocalHead: "head" }), "/api/building-sessions"],
] as const)("sends optional browser defaults on %s creation without a settings mutation", async (_name, create, path) => {
  await expect(create()).resolves.toMatchObject({ id: "created" });
  expect(appFetch).toHaveBeenCalledTimes(1);
  expect(vi.mocked(appFetch).mock.calls[0]![0]).toBe(path);
  expect(JSON.parse(vi.mocked(appFetch).mock.calls[0]![1]!.body as string).browserDefaults).toEqual(defaults);
});

it("preserves explicit settings and leaves profile precedence to atomic creation", async () => {
  await createSession({ profileId: "profile", profileRevision: 4, autonomy: "normal" });
  expect(JSON.parse(vi.mocked(appFetch).mock.calls[0]![1]!.body as string)).toMatchObject({ profileId: "profile", profileRevision: 4, autonomy: "normal", browserDefaults: defaults });
});

it("keeps creation available without browser storage or an authenticated defaults scope", async () => {
  vi.mocked(loadBrowserAgentDefaults).mockResolvedValue(undefined);
  await createSession();
  expect(JSON.parse(vi.mocked(appFetch).mock.calls[0]![1]!.body as string)).toEqual({});
});
