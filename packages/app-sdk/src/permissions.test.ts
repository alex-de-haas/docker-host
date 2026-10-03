import { afterEach, expect, it, vi } from "vitest";
import { permissionNotice, requestPermissionReview, type PermissionNoticeState } from "./permissions";
import { readOwnPermissionNotice } from "./permissions-server";
import { parseActiveFramePermissionReview, parseActiveFrameAssistantReview } from "./embedder";
const state: PermissionNoticeState = { hostRole: "host.admin", appId: "own", corePublicOrigin: "http://core.localhost:7070", permissions: { required: ["apps.read"], optional: ["apps.logs"], granted: [] } };
afterEach(() => vi.unstubAllGlobals());
it("shows known missing required access only to administrators", () => {
  expect(permissionNotice(state)).toBe("missing");
  for (const hostRole of [null, "host.user"]) expect(permissionNotice({ ...state, hostRole })).toBeNull();
  expect(permissionNotice({ ...state, permissions: { required: [], optional: ["apps.logs"], granted: [] } })).toBeNull();
  expect(permissionNotice({ ...state, permissions: { required: [], optional: [], granted: [] } })).toBeNull();
  expect(permissionNotice({ ...state, permissions: { ...state.permissions!, granted: ["apps.read"] } })).toBeNull();
});
it("prioritizes unsupported names and never opens review for them", () => {
  const unsupported = { ...state, permissions: { ...state.permissions!, unsupportedRequired: ["retired"] } };
  expect(permissionNotice(unsupported)).toBe("unsupported");
  const browser = { open: vi.fn(), parent: {} };
  requestPermissionReview(unsupported, browser as unknown as Window);
  expect(browser.open).not.toHaveBeenCalled();
});
it("opens standalone review immediately but only messages the parent when embedded", () => {
  const browser = { open: vi.fn(), parent: null as unknown };
  browser.parent = browser;
  requestPermissionReview(state, browser as unknown as Window);
  expect(browser.open).toHaveBeenCalledWith("http://core.localhost:7070/install/permissions/own", "_blank", "noopener,noreferrer");
  const postMessage = vi.fn(); browser.parent = { postMessage }; browser.open.mockClear();
  requestPermissionReview(state, browser as unknown as Window);
  expect(postMessage).toHaveBeenCalledWith({ type: "hosty:request-permission-review" }, "*");
  expect(browser.open).not.toHaveBeenCalled();
});
it("binds embedded review to the sender frame despite forged app ids and URLs", () => {
  const frame = {};
  const event = { source: frame, origin: "https://own.test", data: { type: "hosty:request-permission-review", appId: "victim", url: "https://evil.test" } };
  expect(parseActiveFramePermissionReview(event, frame, "https://own.test/page", "own")).toBe("own");
  expect(parseActiveFramePermissionReview({ ...event, source: {} }, frame, "https://own.test", "own")).toBeNull();
  expect(parseActiveFramePermissionReview({ ...event, origin: "https://evil.test" }, frame, "https://own.test", "own")).toBeNull();
});
it("keeps service credentials server-side and never queries permissions for non-admin viewers", async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json(state.permissions)); vi.stubGlobal("fetch", fetch);
  const options = { appId: "own", coreOrigin: "http://core.test", serviceToken: "private", corePublicOrigin: "https://core.test" };
  expect((await readOwnPermissionNotice("host.user", options)).permissions).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
  const result = await readOwnPermissionNotice("host.admin", options);
  expect(result.permissions).toEqual(state.permissions);
  expect(String(fetch.mock.calls[0]![0])).toBe("http://core.test/api/internal/apps/own/permissions");
  expect(fetch.mock.calls[0]![1].headers.authorization).toBe("Bearer private");
  expect(JSON.stringify(result)).not.toContain("private");
});

it("binds assistant authority reviews to the sending frame and rejects malformed session IDs", () => {
  const frame = {};
  const event = { source: frame, origin: "http://assistant.test", data: { type: "hosty:request-assistant-authority", appId: "victim", sessionId: "session-one" } };
  expect(parseActiveFrameAssistantReview(event, frame, "http://assistant.test/", "trusted-assistant")).toEqual({ appId: "trusted-assistant", sessionId: "session-one" });
  expect(parseActiveFrameAssistantReview({ ...event, source: {} }, frame, "http://assistant.test/", "trusted-assistant")).toBeNull();
  expect(parseActiveFrameAssistantReview({ ...event, data: { ...event.data, sessionId: "../victim" } }, frame, "http://assistant.test/", "trusted-assistant")).toBeNull();
});
