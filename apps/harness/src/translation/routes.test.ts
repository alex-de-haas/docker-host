import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, expect, it, vi } from "vitest";
import { translationRoute } from "./routes.js";
import type { TranslationService } from "./service.js";
const validate = vi.hoisted(() => vi.fn());
vi.mock("@hosty-sdk/app/providers/server", () => ({ ProviderClient: class { validate = validate; } }));
const service = { capabilities: vi.fn(), translate: vi.fn() };
beforeEach(() => { vi.resetAllMocks(); validate.mockResolvedValue({}); service.translate.mockResolvedValue({ text: "перевод" }); });
function request(body: string, token: string | null = "scoped") {
  return Object.assign(Readable.from([Buffer.from(body)]), { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) } }) as unknown as IncomingMessage;
}
const response = () => Object.assign(new EventEmitter(), { setHeader: vi.fn(), end: vi.fn(), destroyed: false }) as unknown as ServerResponse;
const url = new URL("http://harness.test/api/translation/v1/claude/translations");
it("revalidates exact category/key before consuming a request and does not accept cookies", async () => {
  const res = response();
  await translationRoute(request('{"text":"hello"}'), res, url, service as unknown as TranslationService);
  expect(validate).toHaveBeenCalledWith("scoped", "translation", "claude");
  expect(service.translate).toHaveBeenCalledWith("claude", { text: "hello" }, expect.any(AbortSignal));
  validate.mockRejectedValueOnce(new Error("revoked"));
  await expect(translationRoute(request('{}'), response(), url, service as unknown as TranslationService)).rejects.toThrow("revoked");
  expect(service.translate).toHaveBeenCalledTimes(1);
  await expect(translationRoute(request('{}', null), response(), url, service as unknown as TranslationService)).rejects.toMatchObject({ status: 401 });
});
it.each([["{", 400], ["x".repeat(1_048_577), 413]])("bounds and parses the request before inference", async (body, status) => {
  await expect(translationRoute(request(body as string), response(), url, service as unknown as TranslationService)).rejects.toMatchObject({ status });
  expect(service.translate).not.toHaveBeenCalled();
});
it("cancels inference when the consumer disconnects", async () => {
  const res = response();
  service.translate.mockImplementationOnce(async (_kind, _body, signal: AbortSignal) => {
    res.emit("close"); expect(signal.aborted).toBe(true); throw signal.reason;
  });
  await expect(translationRoute(request('{}'), res, url, service as unknown as TranslationService)).rejects.toMatchObject({ name: "AbortError" });
  expect(res.listenerCount("close")).toBe(0);
});
