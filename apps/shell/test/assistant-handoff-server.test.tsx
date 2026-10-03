// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const provider = vi.hoisted(() => ({ assistant: vi.fn(), prepare: vi.fn(), finalize: vi.fn() }));
vi.mock("@hosty-sdk/app/providers/server", () => ({ ProviderClient: class { assistant = provider.assistant; } }));
import { ProviderError } from "@hosty-sdk/app/providers";
import { AssistantError } from "@hosty-sdk/app/assistant";
import { createAssistantHandoff } from "../src/app/shell/assistant/handoff-server";
const origin = "https://shell.test";
const input = { providerAppId: "helper", key: "default", requestId: "same-request", prompt: "Help", appIds: ["notes"] };
function request(headers = {}, body: unknown = input) {
  return new Request(`${origin}/api/assistant/handoff`, { method: "POST", headers: { Origin: origin,
    cookie: "hosty_shell_identity=own-grant; hosty_shell_csrf=csrf", "X-Hosty-CSRF": "csrf", ...headers }, body: JSON.stringify(body) });
}
beforeEach(() => {
  vi.stubEnv("HOSTY_PUBLIC_ORIGIN_WEB", origin);
  provider.assistant.mockResolvedValue(provider); provider.prepare.mockResolvedValue({ handoffId: "prepared" });
  provider.finalize.mockResolvedValue({ conversationId: "chat", result: { conversationId: "chat", disposition: "draft", open: { endpoint: "web", path: "/chat" } } });
});
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });
it.each([{ Origin: "https://foreign.test" }, { "X-Hosty-CSRF": "wrong" }, { cookie: "" }])("rejects an unauthenticated or cross-origin handoff", async headers => {
  expect((await createAssistantHandoff(request(headers))).status).toBeGreaterThanOrEqual(400);
  expect(provider.assistant).not.toHaveBeenCalled();
});
it("uses the app session only server-side and ignores supplied target URLs and credentials", async () => {
  const response = await createAssistantHandoff(request({ Authorization: "Bearer forged" }, { ...input, url: "https://evil.test", token: "forged" }));
  expect(response.status).toBe(200);
  expect(provider.assistant.mock.calls[0][0]).toEqual({ appId: "helper", key: "default" });
  expect(await provider.assistant.mock.calls[0][1]()).toBe("own-grant");
  expect(provider.prepare).toHaveBeenCalledWith({ requestId: "same-request", prompt: "Help", appIds: ["notes"] });
  expect(provider.finalize).toHaveBeenCalledWith("prepared", []);
  expect(await response.text()).not.toMatch(/own-grant|forged/);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});
it("preserves Core's missing optional permission error without contacting the assistant", async () => {
  provider.assistant.mockRejectedValue(new ProviderError("app_permission_required", "Approve providers.assistant", 403));
  const response = await createAssistantHandoff(request());
  expect(response.status).toBe(403); expect((await response.json()).code).toBe("app_permission_required");
  expect(provider.prepare).not.toHaveBeenCalled();
});
it("preserves a provider handoff conflict without finalizing another conversation", async () => {
  provider.prepare.mockRejectedValue(new AssistantError("request_conflict", "Different input for this request", 409));
  const response = await createAssistantHandoff(request());
  expect(response.status).toBe(409);
  expect((await response.json()).code).toBe("request_conflict");
  expect(provider.finalize).not.toHaveBeenCalled();
});
