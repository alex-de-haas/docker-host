import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreWorkerCommands } from "./core-worker.js";
import { WorkerError } from "./worker.js";

afterEach(() => vi.unstubAllGlobals());

describe("Core worker diagnostics", () => {
  const commands = () => new CoreWorkerCommands("http://core.test", "hosty.harness", "service-test-token");
  it("preserves equals signs in create mount sources and omits worker-owned storage", async () => {
    const fetchMock = vi.fn(async () => Response.json({ output: "created" }));
    vi.stubGlobal("fetch", fetchMock);
    const generation = "11111111-1111-4111-8111-111111111111";
    await commands().run([
      "create", "--name", "hosty-agent-" + "a".repeat(12) + "-" + "b".repeat(12) + "-" + generation,
      "--mount", "type=bind,src=/srv/hosty=data/work=tree,dst=/srv/hosty=data/work=tree",
      "--mount", "type=bind,src=/srv/hosty=data/provider=home,dst=/provider,readonly",
      "--mount", "type=bind,src=/srv/hosty=data/home,dst=/worker/home",
      "--mount", "type=bind,src=/srv/hosty=data/cache,dst=/worker/cache",
      "sha256:" + "c".repeat(64),
    ]);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/agent-worker/create"), expect.objectContaining({
      body: JSON.stringify({ generation, imageId: "sha256:" + "c".repeat(64), mounts: [
        { source: "/srv/hosty=data/work=tree", readonly: false },
        { source: "/srv/hosty=data/provider=home", readonly: true },
      ] }),
    }));
  });
  it("preserves Core resource admission errors as public runtime errors", async () => {
    const message = "The environment container resource budget is exhausted. Remove another app or select larger limits in a new environment.";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ output: message }, { status: 409 })));
    const operation = commands().run(["create", "--name", "hosty-agent-" + "a".repeat(12) + "-" + "b".repeat(12) + "-11111111-1111-4111-8111-111111111111", "sha256:" + "c".repeat(64)]);
    await expect(operation).rejects.toBeInstanceOf(WorkerError);
    await expect(operation).rejects.toMatchObject({ code: "worker_operation_failed", status: 409, message });
  });
  it("diagnoses a disconnected Core without exposing transport or credential details", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("private transport details"); }));
    const operation = commands().run(["info"]);
    await expect(operation).rejects.toBeInstanceOf(WorkerError);
    await expect(operation).rejects.toMatchObject({ code: "worker_core_unavailable", status: 503 });
    await expect(operation).rejects.toThrow("Check Core connectivity and retry.");
    await expect(operation).rejects.not.toThrow("private transport details");
  });
  it("gives upgrade guidance when Core lacks the worker API", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Not found", { status: 404 })));
    const operation = commands().run(["info"]);
    await expect(operation).rejects.toMatchObject({ code: "worker_operation_failed", status: 503 });
    await expect(operation).rejects.toThrow("Update Core before selecting the Docker runtime.");
  });
});
