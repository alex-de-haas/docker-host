import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreEnvironmentClient } from "./sandbox-server";
afterEach(() => vi.unstubAllGlobals());
const options = { appId: "qa.client", coreOrigin: "http://core.test", serviceToken: "service" };
describe("child Core environment client", () => {
  it("requests consent without creating a child and preserves the exact creation UUID", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ approvalUrl: "http://core.test/install/confirm/review" })); vi.stubGlobal("fetch", fetch);
    const client = new CoreEnvironmentClient(async () => "interactive", options);
    const input = { requestId: "a".repeat(32), label: "QA", mode: "current" };
    await client.call("environment-consent", input);
    expect(fetch.mock.calls[0][0].pathname).toBe("/api/internal/apps/qa.client/core-environments/consent");
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(input);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("targets only the child manager and does not retry unknown mutations", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error("lost response")); vi.stubGlobal("fetch", fetch);
    const client = new CoreEnvironmentClient(async () => "operator-grant", options);
    await expect(client.call("environment-create", { requestId: "a".repeat(32), label: "QA" })).rejects.toMatchObject({ code: "environment_outcome_unknown" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0].pathname).toBe("/api/internal/apps/qa.client/core-environments");
    await expect(client.call("environment-finish", { environmentId: "../parent", requestId: "b".repeat(32) })).rejects.toMatchObject({ code: "environment_id_invalid" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("child initialization transport", () => {
  it("uses scoped bounded routes without inventing credentials or replay IDs", async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(Response.json({ phase: "ready" }))); vi.stubGlobal("fetch", fetch);
    const client = new CoreEnvironmentClient(async () => "granted-authority", options);
    const environmentId = "a".repeat(32);
    await client.call("environment-initialization", { environmentId });
    await client.call("environment-initialization-resume", { environmentId });
    await client.call("environment-setup-link", { environmentId });
    expect(fetch.mock.calls.map(([url, init]) => [url.pathname.split(environmentId)[1], init.method]))
      .toEqual([["/initialization", "GET"], ["/initialization/resume", "POST"], ["/setup-link", "POST"]]);
    expect(fetch.mock.calls.every(([, init]) => init.cache === "no-store" && init.headers["X-Hosty-User-Token"] === "granted-authority")).toBe(true);
  });
});
