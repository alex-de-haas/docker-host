import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostyUiResponse, UiServerClient } from "./ui-server";
const options = { appId: "plans", coreOrigin: "https://core.test", serviceToken: "own-service" };
const context = { session: { status: "active" as const, identity: { hostRole: "host.admin" } }, token: "own-user" };
const target = { panel: { appId: "assistant", installationId: "install", panelId: "chat" }, route: "/chat?session=existing" };
afterEach(() => vi.unstubAllGlobals());
describe("fixed panel adapter", () => {
  it("uses only its own service and revalidated user credentials for fixed Core operations", async () => {
    const fetcher = vi.fn(async () => Response.json({ target })); vi.stubGlobal("fetch", fetcher);
    const response = await createHostyUiResponse(new Request("https://plans.test/api/hosty/ui/panels/resolve", {
      method: "POST", headers: { Origin: "https://plans.test", "Content-Type": "application/json", "X-Hosty-User-Token": "forged" }, body: JSON.stringify(target),
    }), context, options);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(fetcher.mock.calls[0]).toMatchObject([new URL("https://core.test/api/internal/apps/plans/ui/panels/resolve"), {
      redirect: "error", headers: { authorization: "Bearer own-service", "X-Hosty-User-Token": "own-user" }, body: JSON.stringify(target),
    }]);
  });
  it("rejects cross-origin, oversized and arbitrary proxy requests before Core work", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const request = (origin: string, body: string) => new Request("https://plans.test/api/hosty/ui/panels/resolve", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body });
    expect((await createHostyUiResponse(request("https://foreign.test", "{}"), context, options)).status).toBe(403);
    expect((await createHostyUiResponse(request("https://plans.test", '"' + "я".repeat(9_000) + '"'), context, options)).status).toBe(413);
    expect((await createHostyUiResponse(new Request("https://plans.test/api/hosty/ui/arbitrary"), context, options)).status).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("preserves access refusals and explicitly identifies an unsupported Core", async () => {
    const fetcher = vi.fn(async () => Response.json({}, { status: 404 })); vi.stubGlobal("fetch", fetcher);
    await expect(new UiServerClient(options).bootstrap({}, "own-user")).rejects.toMatchObject({ code: "unsupported_core" });
    fetcher.mockClear();
    const request = new Request("https://plans.test/api/hosty/ui/bootstrap");
    expect((await createHostyUiResponse(request, { session: { status: "expired" }, token: "old" }, options)).status).toBe(401);
    expect((await createHostyUiResponse(request, { ...context, session: { status: "active", identity: { hostRole: "host.user" } } }, { ...options, administratorOnly: true })).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
