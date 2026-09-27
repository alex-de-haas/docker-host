import { describe, expect, it } from "vitest";
import { assistantContractError, createAssistantRequestId, resolveAssistantDestination } from "./assistant.js";
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
