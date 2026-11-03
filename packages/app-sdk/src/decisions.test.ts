import { afterEach, describe, expect, it, vi } from "vitest";
import { DecisionClient } from "./decisions.js";
import { DecisionServerClient } from "./decisions-server.js";

afterEach(() => vi.unstubAllGlobals());
describe("decision transport", () => {
  it("preserves request identity and conflicting input without an implicit retry", async () => {
    const transport = vi.fn(async () => Response.json({ error: { code: "decision_conflict", message: "Refresh the decision." } }, { status: 409 }));
    const client = new DecisionClient(transport);
    const command = { requestId: "stable-uuid", expectedRevision: 4, answers: { first: { optionIds: ["option-2"] }, second: { text: "Free text" } } };
    await expect(client.resolve("id/one", command)).rejects.toMatchObject({ code: "decision_conflict", status: 409 });
    expect(transport).toHaveBeenCalledExactlyOnceWith("/requests/id%2Fone/resolve", "POST", command, undefined);
  });
  it("uses current user authority for each call and isolates fixed app routes", async () => {
    const request = vi.fn(async () => Response.json({ items: [], pendingCount: 0, cursor: null }));
    vi.stubGlobal("fetch", request);
    const identity = vi.fn().mockResolvedValueOnce("identity-one").mockResolvedValueOnce("identity-two");
    const client = new DecisionServerClient(identity, { appId: "independent.source", serviceToken: "service-token", coreOrigin: "https://core.example.test" });
    await client.list({ subject: "a&b", state: "pending" }); await client.responses();
    expect(identity).toHaveBeenCalledTimes(2);
    const calls = request.mock.calls as unknown as [URL, RequestInit][];
    expect(calls[0]![0].pathname).toBe("/api/internal/apps/independent.source/decisions/v1/requests");
    expect(calls[0]![0].searchParams.get("subject")).toBe("a&b");
    expect(calls[0]![1]).toMatchObject({ redirect: "error", cache: "no-store", headers: { "X-Hosty-User-Token": "identity-one" } });
    expect(calls[1]![1]).toMatchObject({ headers: { "X-Hosty-User-Token": "identity-two" } });
  });
  it("refuses missing user authority before sending even a read", async () => {
    const request = vi.fn(); vi.stubGlobal("fetch", request);
    const client = new DecisionServerClient(() => "", { appId: "independent.source", serviceToken: "service-token", coreOrigin: "https://core.example.test" });
    await expect(client.list()).rejects.toMatchObject({ code: "identity_required", status: 401 });
    expect(request).not.toHaveBeenCalled();
  });
});

it("keeps a decision stream bound to the caller signal and current authority without a request timeout", async () => {
  const stream = new Response("event: stream.ready\ndata: {}\n\n", { headers: { "content-type": "text/event-stream" } });
  const fetcher = vi.fn().mockResolvedValueOnce(stream).mockResolvedValueOnce(Response.json({ error: "revoked" }, { status: 403 }));
  vi.stubGlobal("fetch", fetcher);
  const identity = vi.fn().mockResolvedValueOnce("current-one").mockResolvedValueOnce("current-two");
  const client = new DecisionServerClient(identity, { appId: "independent.source", serviceToken: "service", coreOrigin: "https://core.example.test" });
  const abort = new AbortController();
  expect(await client.events(abort.signal)).toBe(stream);
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ signal: abort.signal, redirect: "error", headers: { "X-Hosty-User-Token": "current-one" } });
  await expect(client.events(abort.signal)).rejects.toMatchObject({ code: "decision_stream_unavailable", status: 403 });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[1]?.[1].headers["X-Hosty-User-Token"]).toBe("current-two");
});
