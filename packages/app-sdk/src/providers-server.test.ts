import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderClient } from "./providers-server";
const provider = { appId: "speech", key: "default", kind: "speech-to-text" as const, displayName: "Speech", version: 1, url: "http://127.0.0.1:3500/api/speech/v1", capabilities: ["recording"], available: true };
const client = () => new ProviderClient({ appId: "ordinary", coreOrigin: "http://core.test", serviceToken: "private-service" });
afterEach(() => vi.unstubAllGlobals());
describe("provider credentials", () => {
  it("keeps service credentials in Core and sends only scoped authority and audio to the chosen provider", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ token: "scoped", provider })).mockResolvedValueOnce(Response.json({ text: "hello" }));
    vi.stubGlobal("fetch", fetch);
    expect(await client().transcribe(provider, new Blob(["wave"], { type: "audio/wav" }))).toEqual({ text: "hello" });
    expect(String(fetch.mock.calls[0]![0])).toBe("http://core.test/api/internal/apps/ordinary/providers/speech-to-text/token");
    expect(fetch.mock.calls[0]![1].headers.authorization).toBe("Bearer private-service");
    expect(fetch.mock.calls[1]![1]).toMatchObject({ headers: { authorization: "Bearer scoped", "content-type": "audio/wav" }, redirect: "error" });
    expect(await fetch.mock.calls[1]![1].body.text()).toBe("wave");
  });
  it("preserves denial and never tries a provider after Core refuses permission", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ code: "app_permission_required", message: "Denied" }, { status: 403 })); vi.stubGlobal("fetch", fetch);
    await expect(client().transcribe(provider, new Blob())).rejects.toMatchObject({ code: "app_permission_required", status: 403 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("rejects incompatible interfaces before transferring audio", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ token: "scoped", provider: { ...provider, version: 2 } })); vi.stubGlobal("fetch", fetch);
    await expect(client().transcribe(provider, new Blob())).rejects.toMatchObject({ code: "provider_incompatible" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("passes cancellation through both authority and transcription calls", async () => {
    const controller = new AbortController();
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ token: "scoped", provider })).mockImplementationOnce(async (_url, options) => {
      controller.abort(); expect(options.signal.aborted).toBe(true); throw options.signal.reason;
    }); vi.stubGlobal("fetch", fetch);
    await expect(client().transcribe(provider, new Blob(), { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch.mock.calls[0]![1].signal.aborted).toBe(true);
  });
});

describe("translation providers", () => {
  const selected = { ...provider, appId: "harness", key: "claude", kind: "translation", url: "http://harness.test/api/translation/v1/claude" };
  const input = { text: "# Example\n\n- [ ] D1. Read.", targetLanguage: "ru", format: "markdown" as const };
  it("sends Markdown and only the scoped credential to the exact selected key", async () => {
    const result = { text: "# Пример\n\n- [ ] D1. Прочитать.", targetLanguage: "ru", sourceLanguage: "auto" };
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ token: "scoped", provider: selected })).mockResolvedValueOnce(Response.json(result)); vi.stubGlobal("fetch", fetch);
    expect(await client().translate(selected, input)).toEqual(result);
    expect(String(fetch.mock.calls[0]![0])).toContain("/providers/translation/token");
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({ providerAppId: "harness", key: "claude" });
    expect(fetch.mock.calls[1]).toEqual([selected.url + "/translations", expect.objectContaining({ redirect: "error", headers: { authorization: "Bearer scoped", "content-type": "application/json" }, body: JSON.stringify(input) })]);
  });
  it.each(["denied", "version", "response"])("fails closed for %s without retry or fallback", async failure => {
    const fetch = vi.fn().mockResolvedValueOnce(failure === "denied" ? Response.json({ code: "app_permission_required" }, { status: 403 })
      : Response.json({ token: "scoped", provider: { ...selected, version: failure === "version" ? 2 : 1 } })).mockResolvedValueOnce(Response.json({ text: "wrong language", targetLanguage: "en", sourceLanguage: "auto" }));
    vi.stubGlobal("fetch", fetch);
    await expect(client().translate(selected, input)).rejects.toMatchObject({ code: failure === "denied" ? "app_permission_required" : failure === "version" ? "provider_incompatible" : "provider_response_invalid" });
    expect(fetch).toHaveBeenCalledTimes(failure === "response" ? 2 : 1);
  });
  it("cancels an in-flight translation", async () => {
    const controller = new AbortController();
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ token: "scoped", provider: selected })).mockImplementationOnce(async (_u, options) => {
      controller.abort(); expect(options.signal.aborted).toBe(true); throw options.signal.reason;
    }); vi.stubGlobal("fetch", fetch);
    await expect(client().translate(selected, input, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
