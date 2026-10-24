import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCoreDevelopment, type CoreDevelopment } from "../src/app/shell/core-development";

const transport = vi.hoisted(() => ({ read: vi.fn(), send: vi.fn(), error: vi.fn() }));
vi.mock("../src/app/shell/core-transport.js", () => ({ fetchCore: transport.read }));
vi.mock("../src/app/shell/shell-context", () => ({ useShellActions: () => ({ sendCsrfJson: transport.send }) }));
vi.mock("../src/components/reui/operation-toast", () => ({ toast: { success: vi.fn(), error: transport.error } }));
const origin = "http://core.test";
const state: CoreDevelopment = {
  launch: { mode: "dev", projectPath: "/tree/Core.csproj", generationPath: "/generation", processId: 42, startedAt: "before" },
  instance: "42:before", manageable: true, source: { overridePath: null, revision: "before" },
  managedPath: "/source", sourcePath: "/source", selectedProjectPath: "/source/Core.csproj", restartRequired: false,
  branch: "main", commit: null, changedFiles: 0, additions: 0, deletions: 0, gitError: null,
};
let root: Root, container: HTMLDivElement;
let development: ReturnType<typeof useCoreDevelopment>;
function Probe() {
  const value = useCoreDevelopment(origin, true);
  useEffect(() => { development = value; }, [value]);
  return null;
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  sessionStorage.clear();
  transport.read.mockReset().mockImplementation(async (url: string) => Response.json(url.includes("/operations/") ? { status: "building" } : state));
  transport.send.mockReset().mockResolvedValue(Response.json({ status: "accepted" }));
  transport.error.mockReset();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<Probe />));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); sessionStorage.clear(); vi.unstubAllGlobals(); });

it("submits Release against the confirmed post-Return Core identity rather than an older poll", async () => {
  const returned = { ...state, instance: "99:returned", source: { ...state.source, revision: "returned" } };
  let id: string | undefined;
  await act(async () => { id = await development.restart("release", returned); });
  expect(id).toMatch(/^[a-f0-9]{32}$/);
  expect(transport.send).toHaveBeenCalledWith(origin + "/api/core/restart", {
    requestId: id, instance: "99:returned", mode: "release", sourceRevision: "returned",
  }, "POST", undefined);
  expect(sessionStorage.getItem("hosty:core-operation:" + origin)).toBe(id);
});

it("returns and retains the same durable request after a lost reply and blocks duplicate restarts", async () => {
  transport.send.mockRejectedValue(new Error("Connection closed during Core handover"));
  let id: string | undefined, duplicate: string | undefined;
  await act(async () => { id = await development.restart("release"); duplicate = await development.restart("release"); });
  expect(id).toMatch(/^[a-f0-9]{32}$/);
  expect(duplicate).toBeUndefined();
  expect(transport.send).toHaveBeenCalledTimes(1);
  expect(sessionStorage.getItem("hosty:core-operation:" + origin)).toBe(id);
  expect(development.busy).toBe(true);
  expect(transport.error).toHaveBeenCalled();
});
