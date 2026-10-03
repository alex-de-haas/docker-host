import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantClient, assistantContractError, createAssistantRequestId, resolveAssistantDestination } from "./assistant.js";
import { AssistantError } from "./assistant.js";
describe("assistant contract", () => {
  it("requires the base version but permits missing optional attachments and unknown optional capabilities", () => {
    expect(assistantContractError({})).not.toBeNull();
    expect(assistantContractError({ version: 2, capabilities: [] })).not.toBeNull();
    expect(assistantContractError({ version: 1, capabilities: ["future-feature"] })).toBeNull();
  });
  it("generates unique UUIDv7 identities carrying the request time", () => {
    const time = 1790000000000, id = createAssistantRequestId(time);
    expect(id[14]).toBe("7"); expect(parseInt(id.replaceAll("-", "").slice(0, 12), 16)).toBe(time);
    expect(createAssistantRequestId(time)).not.toBe(id);
  });
  const surfaces = [{ endpoint: "chat", path: "/my-ui", url: "https://assistant.example/my-ui" }];
  it("opens a provider-owned UI without assuming Harness routes", () => {
    expect(resolveAssistantDestination({ endpoint: "chat", path: "/my-ui/conversations/abc?view=voice" }, surfaces)).toBe("https://assistant.example/my-ui/conversations/abc?view=voice");
  });
  it.each(["https://evil.example/", "//evil.example/", "/my-ui/../admin", "/my-ui-other", "/my-ui/%2f../admin", "/my-ui/%255c../admin", "/my-ui/%2e%2e/admin", "/my-ui/\\evil"])("rejects a destination outside the declared UI: %s", path => {
    expect(() => resolveAssistantDestination({ endpoint: "chat", path }, surfaces)).toThrow();
  });
  it("rejects another endpoint", () => {
    expect(() => resolveAssistantDestination({ endpoint: "other", path: "/my-ui" }, surfaces)).toThrow();
  });
});

describe("assistant upload deadlines", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
  it.each([[403, "app_permission_required"], [409, "request_conflict"], [410, "request_expired"]])(
    "preserves provider status %s and code %s for server-side consumers", async (status, code) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ code, message: "Request refused" }, { status }));
      const client = new AssistantClient("https://assistant/api", { version: 1, capabilities: [] }, async () => ({ token: "test" }));
      const request = client.prepare({ requestId: createAssistantRequestId(), prompt: "Help", appIds: [] });
      await expect(request).rejects.toBeInstanceOf(AssistantError);
      await expect(request).rejects.toMatchObject({ status, code, message: "Request refused" });
    });
  it("allows an upload lasting longer than the control deadline", async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      expect(init?.signal).toBeUndefined();
      await new Promise(resolve => setTimeout(resolve, 75_000));
      return Response.json({ attachmentId: "file" });
    });
    const client = new AssistantClient("https://assistant/api", { version: 1, capabilities: ["attachments"] }, async () => ({ token: "test" }));
    const upload = client.upload("handoff", "file", new Blob(["data"]), "file.data");
    await vi.advanceTimersByTimeAsync(75_000);
    expect(await upload).toMatchObject({ attachmentId: "file" });
    expect(timeout).not.toHaveBeenCalled();
  });
  it("passes the caller's cancellation signal through token refresh and retains control deadlines", async () => {
    const controller = new AbortController(); const signals: unknown[] = [];
    const timeout = vi.spyOn(AbortSignal, "timeout");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      signals.push(init?.signal);
      return signals.length === 1 ? Response.json({}, { status: 401 }) : Response.json({});
    });
    const client = new AssistantClient("https://assistant/api", { version: 1, capabilities: ["attachments"] }, async () => ({ token: "test" }));
    await client.upload("handoff", "file", new Blob(["data"]), "file", { signal: controller.signal });
    expect(signals).toEqual([controller.signal, controller.signal]);
    expect(timeout).not.toHaveBeenCalled();
    await client.status("handoff"); expect(timeout).toHaveBeenCalledWith(60_000);
  });
});
