import { afterEach, expect, it, vi } from "vitest";
import { ProviderClient } from "./providers-server";
import { TaskClient, TaskExecutorClient } from "./tasks-server";
const ref = { appId: "independent.tasks", key: "default", installationId: "installation-one" };
const providers = () => new ProviderClient({ appId: "producer", coreOrigin: "http://core.test", serviceToken: "private-service" });
const descriptor = (kind: string) => ({ ...ref, kind, version: 1, url: "http://provider.test/v1", available: true });
afterEach(() => vi.unstubAllGlobals());
it("discovers authority afresh for each task request and forwards neither service nor user credentials", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ token: "scoped-one", provider: descriptor("tasks") }))
    .mockResolvedValueOnce(Response.json({ tasks: [], nextCursor: null }))
    .mockResolvedValueOnce(Response.json({ token: "scoped-two", provider: descriptor("tasks") }))
    .mockResolvedValueOnce(Response.json({ tasks: [], nextCursor: null }));
  vi.stubGlobal("fetch", fetch);
  const client = new TaskClient(providers(), ref, async () => "private-user");
  await client.list(); await client.list();
  expect(fetch.mock.calls[0]![1].headers).toMatchObject({ authorization: "Bearer private-service", "X-Hosty-User-Token": "private-user" });
  expect(fetch.mock.calls[1]![1].headers).toEqual({ authorization: "Bearer scoped-one", "content-type": "application/json" });
  expect(fetch.mock.calls[3]![1].headers.authorization).toBe("Bearer scoped-two");
});
it("preserves caller-chosen execution and cancellation IDs across lost replies", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ token: "scoped", provider: descriptor("task-executor") }))
    .mockRejectedValueOnce(new Error("reply lost"))
    .mockResolvedValueOnce(Response.json({ token: "scoped", provider: descriptor("task-executor") }))
    .mockResolvedValueOnce(Response.json({ executionId: "execution-id", state: "accepted" }));
  vi.stubGlobal("fetch", fetch); const client = new TaskExecutorClient(providers(), ref);
  const input = { taskRef: { ...ref, id: "task-id" }, taskRevision: 1, input: { title: "work", markdown: "do work", requiresReview: false, resources: [] } };
  await expect(client.accept("execution-id", input)).rejects.toThrow("reply lost");
  expect(fetch).toHaveBeenCalledTimes(2);
  await client.accept("execution-id", input);
  expect(fetch.mock.calls[1]![0]).toEqual(fetch.mock.calls[3]![0]);
  expect(fetch.mock.calls[1]![1]).toMatchObject({ method: "PUT", body: fetch.mock.calls[3]![1].body });
});
it("rejects another installation and route escape before reaching the provider", async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ token: "scoped", provider: { ...descriptor("tasks"), installationId: "replacement" } }));
  vi.stubGlobal("fetch", fetch);
  await expect(new TaskClient(providers(), ref).list()).rejects.toMatchObject({ code: "provider_changed" });
  expect(fetch).toHaveBeenCalledTimes(1);
  await expect(providers().taskRequest(ref, "tasks", "/tasks/../admin", "GET")).rejects.toMatchObject({ code: "task_route_invalid" });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(() => new TaskClient(providers(), ref).get({ ...ref, installationId: "other", id: "x" })).toThrow("another provider");
});
