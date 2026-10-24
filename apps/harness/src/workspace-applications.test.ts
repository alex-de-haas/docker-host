import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DevelopmentClient } from "./sessions/development.js";
import { AppContextError } from "./sessions/app-context.js";
import { requestWorkspaceApplications, workspaceApplicationsRoute, type WorkspaceApplicationsConnection } from "./workspace-applications.js";

const workspaceId = "a".repeat(64), treeId = "b".repeat(64), otherTree = "c".repeat(64);
const requestId = "c5219129-11db-4b23-b690-d94388dc7269";
const root = `/api/development-workspaces/${workspaceId}/applications`;
const target = { kind: "workspace", name: "Small fix", workspaceId, worktreeId: treeId, runtime: "dev", available: true };
const app = { id: "example.app", displayName: "Example", version: "1.2.3", runtimeState: "running", operationStatus: "ready",
  selectedRuntime: "docker", health: { status: "healthy" }, settings: [{ value: "secret-setting" }], sourceCommit: "private-commit" };
const input = { requestId, kind: "workspace", workspaceId, worktreeId: treeId, runtime: "dev" };
let inspect: ReturnType<typeof vi.fn<(credential: string) => Promise<unknown>>>;
let fetcher: ReturnType<typeof vi.fn<(url: URL, init: RequestInit) => Promise<Response>>>;
let connection: WorkspaceApplicationsConnection;
let lifecycle: boolean, sources: boolean, execution: Record<string, unknown>;
beforeEach(() => {
  lifecycle = true; sources = true; app.selectedRuntime = "docker";
  delete (app as Record<string, unknown>).sourceLivePath;
  execution = { appId: app.id, current: { kind: "package", name: "docker", runtime: "docker" }, choices: [target] };
  inspect = vi.fn(async (_credential: string): Promise<unknown> => ({ workspaces: [{ id: workspaceId, workflow: { state: "in-progress" },
    worktrees: [{ id: treeId, state: "active", apps: [{ appId: app.id, name: "Example app", installed: true },
      { appId: "removed.app", name: "Removed", installed: false }] }] }] }));
  connection = { origin: "https://core.test", appId: "custom.assistant", serviceToken: "service-secret", inspect };
  fetcher = vi.fn(async (url: URL, init: RequestInit) => {
    if (url.pathname === "/api/apps") return Response.json({ apps: [app,
      { id: "custom.assistant", grantedCorePermissions: [...(lifecycle ? ["apps.lifecycle"] : []), ...(sources ? ["apps.sources.full"] : [])] },
      { id: "unrelated.app", version: "fleet-secret" }] });
    if (url.pathname === "/api/apps/execution-targets") return Response.json({ apps: [execution,
      { appId: "unrelated.app", current: { name: "unrelated-private-workspace" } }] });
    if (url.pathname === `/api/apps/${app.id}/source/summary`) return Response.json({ appId: app.id, branch: "feature/own", scopePath: "/source/own", state: "changes", error: "internal-source-error" });
    return Response.json({ requestId, state: "completed", app: { settings: "do-not-return" }, accepted: init.body });
  });
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const read = () => requestWorkspaceApplications("GET", root, "hostyg_user", undefined, connection) as Promise<{ apps: Record<string, unknown>[] }>;
const submit = (body: unknown = input) => requestWorkspaceApplications("POST", `${root}/${app.id}/execution-target`, "hostyg_user", body, connection);

it("recognizes only exact scoped routes and the intended methods", () => {
  expect(workspaceApplicationsRoute("GET", root)).toEqual({ workspaceId });
  expect(workspaceApplicationsRoute("POST", `${root}/${app.id}/execution-target`)).toMatchObject({ workspaceId, appId: app.id });
  expect(workspaceApplicationsRoute("GET", `${root}/${app.id}/execution-target/${requestId}`)).toMatchObject({ requestId });
  for (const [method, path] of [["POST", root], ["GET", `${root}/${app.id}/execution-target`], ["POST", `${root}/${app.id}/execution-target/${requestId}`],
    ["GET", `${root}/../apps`], ["GET", `${root}/Example.app/execution-target/${requestId}`], ["GET", `${root}/${app.id}/execution-target/${"-".repeat(36)}`]])
    expect(workspaceApplicationsRoute(method!, path!)).toBeNull();
});

it("projects only installed bound apps, current target and granted action capability", async () => {
  const result = await read();
  expect(result.apps).toHaveLength(1);
  expect(result.apps[0]).toMatchObject({ appId: app.id, name: "Example app", version: "1.2.3", runtimeState: "running", health: "healthy",
    current: { kind: "package", runtime: "docker" }, target, canSwitch: true });
  const json = JSON.stringify(result);
  for (const value of ["secret-setting", "private-commit", "unrelated.app", "fleet-secret", "unrelated-private-workspace", "service-secret", "custom.assistant", "removed.app"])
    expect(json).not.toContain(value);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(inspect).toHaveBeenCalledExactlyOnceWith("hostyg_user");
  for (const [, init] of fetcher.mock.calls) {
    expect(init).toMatchObject({ method: "GET", redirect: "error", cache: "no-store", headers: {
      authorization: "Bearer service-secret", "X-Hosty-App-Identity": "hostyg_user", "content-type": "application/json" } });
    expect(init).not.toHaveProperty("credentials");
    expect(init.headers).not.toHaveProperty("cookie");
    expect(init.headers).not.toHaveProperty("X-Hosty-User-Token");
  }
});

it("keeps inventory readable without optional lifecycle authority and never invents a current package", async () => {
  lifecycle = false;
  expect((await read()).apps[0]).toMatchObject({ canSwitch: false, unavailable: expect.stringContaining("lifecycle permission") });
  execution = { ...execution, current: undefined };
  expect((await read()).apps[0]).toMatchObject({ canSwitch: false, current: undefined, unavailable: expect.stringContaining("Current execution target") });
});

it("does not make a missing, unavailable or unrelated workspace choice actionable", async () => {
  for (const candidate of [undefined, { ...target, available: false, unavailable: "Runtime needs configuration." },
    { ...target, workspaceId: "f".repeat(64) }, { ...target, worktreeId: otherTree }]) {
    execution = { ...execution, choices: candidate ? [candidate] : [] };
    expect((await read()).apps[0]?.canSwitch).toBe(false);
  }
  sources = false; execution = { ...execution, choices: [target] };
  expect((await read()).apps[0]).toMatchObject({ canSwitch: false, unavailable: expect.stringContaining("source workspace permission") });
});

it("retains Core's unavailable recipe reason when it cannot resolve an exact tree", async () => {
  execution = { ...execution, choices: [{ ...target, worktreeId: undefined, available: false, unavailable: "Choose a worktree before using this application." }] };
  expect((await read()).apps[0]).toMatchObject({ canSwitch: false, target: { available: false }, unavailable: "Choose a worktree before using this application." });
});

it("keeps paused workspace rows readable without offering a fresh switch", async () => {
  const inventory = await inspect("hostyg_user") as { workspaces: { workflow: Record<string, unknown> }[] };
  inventory.workspaces[0]!.workflow.closure = "closed";
  inspect.mockResolvedValue(inventory);
  expect((await read()).apps[0]).toMatchObject({ canSwitch: false, unavailable: expect.stringContaining("Resume this workspace") });
});

it("shows a legacy live source without pretending it is a named workspace", async () => {
  Object.assign(app, { selectedRuntime: "dev", sourceLivePath: "/source/own" });
  execution = { ...execution, current: { kind: "legacy", name: "dev", runtime: "dev" } };
  const row = (await read()).apps[0]!;
  expect(row).toMatchObject({ current: { kind: "legacy" }, source: { path: "/source/own", branch: "feature/own", state: "changes" } });
  expect(JSON.stringify(row)).not.toContain("internal-source-error");
  lifecycle = false;
  expect((await read()).apps[0]).toMatchObject({ source: { path: "/source/own", state: "unknown" } });
});

it("retains unknown source detail when its optional probe fails", async () => {
  execution = { ...execution, current: { kind: "legacy", name: "dev" } };
  const original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url: URL, init: RequestInit) => url.pathname.endsWith("/source/summary")
    ? Response.json({ code: "source_unavailable", message: "Unavailable" }, { status: 409 }) : original(url, init));
  expect((await read()).apps[0]).toMatchObject({ current: { kind: "legacy" }, source: { state: "unknown" } });
});

it("forwards exact per-app intent on retry rather than substituting a changed recipe", async () => {
  expect(await submit()).toEqual({ requestId, state: "completed", code: undefined, error: undefined });
  execution = { ...execution, choices: [{ ...target, runtime: "new-recipe" }] };
  await submit();
  expect(fetcher).toHaveBeenCalledTimes(2);
  for (const [url, init] of fetcher.mock.calls) {
    expect(String(url)).toBe(`https://core.test/api/apps/${app.id}/execution-target`);
    expect(init).toMatchObject({ method: "POST", body: JSON.stringify(input), headers: {
      authorization: "Bearer service-secret", "X-Hosty-App-Identity": "hostyg_user" } });
  }
});

it.each([
  { ...input, requestId: "new-id" }, { ...input, kind: "package" }, { ...input, workspaceId: "f".repeat(64) },
  { ...input, worktreeId: otherTree }, { ...input, runtime: 12 }, { ...input, runtime: "" },
  { ...input, coreSelected: true }, { ...input, authority: "local-control" }, { ...input, worktreeId: undefined },
])("rejects malformed or cross-scope intent before any management request", async invalid => {
  await expect(submit(invalid)).rejects.toMatchObject({ status: 400, code: "workspace_execution_invalid" });
  expect(fetcher).not.toHaveBeenCalled();
});

it("refuses unbound apps and inaccessible workspaces before fetching fleet data", async () => {
  await expect(requestWorkspaceApplications("POST", `${root}/unrelated.app/execution-target`, "hostyg_user", input, connection))
    .rejects.toMatchObject({ status: 403, code: "workspace_application_forbidden" });
  inspect.mockResolvedValue({ workspaces: [] });
  await expect(read()).rejects.toMatchObject({ status: 404, code: "workspace_not_found" });
  expect(fetcher).not.toHaveBeenCalled();
});

it("recovers the original per-app receipt with GET and projects only its concrete workspace review", async () => {
  const workspaceManifest = { appId: app.id, nonce: "proof", manifestDigest: "digest" };
  fetcher.mockResolvedValue(Response.json({ requestId, state: "review-required", code: "dev_review_required", error: "Review access",
    app: { settings: "private-setting" }, review: { workspaceManifest, privateField: "do-not-return" } }));
  expect(await requestWorkspaceApplications("GET", `${root}/${app.id}/execution-target/${requestId}`, "hostyg_user", undefined, connection))
    .toEqual({ requestId, state: "review-required", code: "dev_review_required", error: "Review access", review: { workspaceManifest } });
  expect(fetcher.mock.calls[0]).toEqual([new URL(`https://core.test/api/apps/${app.id}/execution-target/${requestId}`), expect.objectContaining({ method: "GET" })]);
});

it("preserves Core authorization refusals and sanitizes network and malformed-response failures", async () => {
  fetcher.mockResolvedValue(Response.json({ code: "app_permission_required", message: "Lifecycle permission is required.", debug: "secret-debug" }, { status: 403 }));
  await expect(submit()).rejects.toMatchObject({ status: 403, code: "app_permission_required", message: "Lifecycle permission is required." });
  fetcher.mockRejectedValue(new Error("service-secret-in-transport-error"));
  const failed = await submit().catch(error => error as AppContextError);
  expect(failed).toMatchObject({ status: 503, code: "core_unavailable" });
  expect((failed as AppContextError).message).not.toContain("service-secret");
  fetcher.mockResolvedValue(new Response("<html>secret-debug</html>"));
  await expect(submit()).rejects.toMatchObject({ status: 502, code: "core_response_invalid" });
});

it("refuses a receipt for another intent and does not bypass inspection denial", async () => {
  fetcher.mockResolvedValue(Response.json({ requestId: "638507af-b413-427b-a909-c79550990039", state: "completed" }));
  await expect(submit()).rejects.toMatchObject({ status: 502, code: "core_response_invalid" });
  fetcher.mockClear();
  inspect.mockRejectedValue(new AppContextError(403, "workspace_forbidden", "Not this operator's source."));
  await expect(read()).rejects.toMatchObject({ status: 403, code: "workspace_forbidden" });
  expect(fetcher).not.toHaveBeenCalled();
});

it("DevelopmentClient reuses authorized inspection and paired app-management credentials", async () => {
  const client = new DevelopmentClient("https://core.test", "custom.assistant", "service-secret");
  const upstream = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url: URL, init: RequestInit) => url.pathname.endsWith("/workspace-inspection")
    ? Response.json(await inspect("hostyg_user")) : upstream(url, init));
  await client.workspaceApplications("hostyg_user", "GET", root);
  expect(fetcher.mock.calls[0]).toEqual([new URL("https://core.test/api/internal/apps/custom.assistant/workspace-inspection"), expect.objectContaining({
    headers: expect.objectContaining({ authorization: "Bearer service-secret", "X-Hosty-User-Token": "hostyg_user" }) })]);
  expect(fetcher.mock.calls[1]?.[1].headers).toHaveProperty("X-Hosty-App-Identity", "hostyg_user");
});
