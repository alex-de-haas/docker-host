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
