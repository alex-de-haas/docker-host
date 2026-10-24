import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCoreStop } from "../src/app/shell/core-stop";
import type { CoreDevelopment } from "../src/app/shell/core-development";

const transport = vi.hoisted(() => ({ read: vi.fn(), send: vi.fn(), info: vi.fn(), error: vi.fn() }));
vi.mock("../src/app/shell/core-transport.js", () => ({ fetchCore: transport.read }));
vi.mock("../src/app/shell/shell-context", () => ({ useShellActions: () => ({ sendCsrfJson: transport.send }) }));
vi.mock("../src/components/reui/operation-toast", () => ({ toast: { info: transport.info, error: transport.error } }));
const origin = "https://core.test";
const initial: CoreDevelopment = {
  launch: { mode: "dev", projectPath: "/tree/Core.csproj", generationPath: "/generation", processId: 42, startedAt: "before" },
  instance: "42:before", manageable: true, source: { overridePath: null, revision: "source-before" },
  managedPath: "/source", sourcePath: "/source", selectedProjectPath: "/source/Core.csproj", restartRequired: false,
  branch: "main", commit: null, changedFiles: 0, additions: 0, deletions: 0, gitError: null,
};
let root: Root, container: HTMLDivElement;
let control: ReturnType<typeof useCoreStop>;
let fresh: CoreDevelopment;
function Probe({ coreOrigin, state, disabled }: { coreOrigin: string; state: CoreDevelopment | null; disabled: boolean }) {
  const value = useCoreStop(coreOrigin, state, disabled);
  useEffect(() => { control = value; }, [value]);
  return <>{value.dialog}<span role="status">{value.phase}</span></>;
}
async function render(state: CoreDevelopment | null = initial, coreOrigin = origin, disabled = false) {
  await act(async () => root.render(<Probe coreOrigin={coreOrigin} state={state} disabled={disabled} />));
}
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === text)!;
async function request() {
  let promise!: Promise<void>;
  await act(async () => { promise = control.stop(); });
  return { promise };
}
async function accept(promise: Promise<void>) { await act(async () => { button("Stop Core").click(); await promise; }); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const accepted = (instance = fresh.instance) => Response.json({ status: "accepted", instance, keepApps: true }, { status: 202 });
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fresh = initial;
  transport.read.mockReset().mockImplementation(async () => Response.json(fresh));
  transport.send.mockReset().mockImplementation(async () => accepted());
  transport.info.mockReset(); transport.error.mockReset();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await render();
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); document.body.innerHTML = ""; vi.unstubAllGlobals(); });

it("refreshes the displayed process before explicit confirmation and guards duplicate read, confirmation and stop requests", async () => {
  const read = deferred<Response>(); transport.read.mockReturnValueOnce(read.promise);
  const { promise } = await request();
  await act(async () => { await control.stop(); });
  expect(transport.read).toHaveBeenCalledExactlyOnceWith(origin + "/api/core/development", expect.objectContaining({ cache: "no-store", credentials: "include", signal: expect.any(AbortSignal) }));
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(transport.send).not.toHaveBeenCalled();
  await act(async () => read.resolve(Response.json(initial)));
  const dialog = document.querySelector('[role="alertdialog"]')!;
  expect(dialog.textContent).toContain("Core APIs and Shell management will go offline");
  expect(dialog.textContent).toContain("Runtime applications keep running");
  expect(dialog.textContent).toContain("Restart Core with the local Hosty CLI");
  await act(async () => { await control.stop(); });
  expect(document.querySelectorAll('[role="alertdialog"]')).toHaveLength(1);
  expect(transport.send).not.toHaveBeenCalled();
  await accept(promise);
  expect(transport.send).toHaveBeenCalledExactlyOnceWith(origin + "/api/core/stop", { instance: initial.instance }, "POST", expect.any(AbortSignal));
  expect(control.busy).toBe(true); expect(control.phase).toBe("Stop requested");
  expect(transport.info).toHaveBeenCalledWith("Core stop requested", expect.anything());
  await act(async () => { await control.stop(); });
  expect(transport.read).toHaveBeenCalledTimes(1); expect(transport.send).toHaveBeenCalledTimes(1);
});

it("cancels without posting or retaining the duplicate guard", async () => {
  const { promise } = await request();
  await act(async () => { button("Cancel").click(); await promise; });
  expect(control.busy).toBe(false); expect(control.phase).toBeNull(); expect(control.error).toBeNull();
  expect(transport.send).not.toHaveBeenCalled(); expect(transport.info).not.toHaveBeenCalled();
  const next = await request();
  expect(transport.read).toHaveBeenCalledTimes(2);
  await act(async () => { button("Cancel").click(); await next.promise; });
});

it.each(["changed", "unmanageable", "read-error"])("refuses a %s process before asking for confirmation", async problem => {
  transport.read.mockResolvedValueOnce(problem === "read-error"
    ? Response.json({ message: "Core launch status is unavailable" }, { status: 503 })
    : Response.json({ ...initial, instance: problem === "changed" ? "43:replacement" : initial.instance, manageable: problem !== "unmanageable" }));
  await act(async () => control.stop());
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(transport.send).not.toHaveBeenCalled(); expect(control.busy).toBe(false); expect(control.error).toBeTruthy();
  expect(transport.error).toHaveBeenCalledWith("Core stop failed", expect.anything());
});

it("leaves a stale-instance rejection visible and allows only an explicitly confirmed retry", async () => {
  transport.send.mockResolvedValueOnce(Response.json({ code: "core_instance_changed", message: "The reviewed process changed" }, { status: 409 }));
  const first = await request(); await accept(first.promise);
  expect(control.busy).toBe(false); expect(control.error).toBe("The reviewed process changed");
  expect(transport.send).toHaveBeenCalledTimes(1); expect(transport.info).not.toHaveBeenCalled();
  const second = await request();
  expect(transport.send).toHaveBeenCalledTimes(1);
  await accept(second.promise);
  expect(transport.send).toHaveBeenCalledTimes(2); expect(control.phase).toBe("Stop requested");
});

it.each(["lost reply", "unrecognized receipt"])("retains uncertainty after a %s without reporting exit or replaying the mutation", async problem => {
  if (problem === "lost reply") transport.send.mockRejectedValueOnce(new Error("Connection closed during shutdown"));
  else transport.send.mockResolvedValueOnce(Response.json({ status: "completed" }));
  const { promise } = await request(); await accept(promise);
  expect(control.busy).toBe(true); expect(control.phase).toBe("Stop not confirmed");
  expect(transport.info).not.toHaveBeenCalled();
  expect(transport.error).toHaveBeenCalledWith("Core stop could not be confirmed", expect.objectContaining({ description: expect.stringContaining("not retried automatically") }));
  await act(async () => { await control.stop(); });
  expect(transport.read).toHaveBeenCalledTimes(1); expect(transport.send).toHaveBeenCalledTimes(1);
});

it("cancels a pending confirmation when management is disabled", async () => {
  const { promise } = await request();
  await render(initial, origin, true); await act(async () => promise);
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(control.busy).toBe(false); expect(transport.send).not.toHaveBeenCalled();
  await render(); const next = await request();
  expect(transport.read).toHaveBeenCalledTimes(2);
  await act(async () => { button("Cancel").click(); await next.promise; });
});

it("aborts obsolete request continuations when Core scope changes", async () => {
  const posted = deferred<Response>(); transport.send.mockReturnValueOnce(posted.promise);
  const { promise } = await request();
  await act(async () => button("Stop Core").click());
  const signal = transport.send.mock.calls[0][3] as AbortSignal;
  await render(initial, "https://other-core.test");
  expect(signal.aborted).toBe(true); expect(control.busy).toBe(false);
  await act(async () => { posted.resolve(accepted()); await promise; });
  expect(control.phase).toBeNull(); expect(control.error).toBeNull();
  expect(transport.info).not.toHaveBeenCalled(); expect(transport.error).not.toHaveBeenCalled();
});

it("clears the retained stop request only for a newly observed Core instance", async () => {
  const first = await request(); await accept(first.promise);
  expect(control.busy).toBe(true);
  fresh = { ...initial, instance: "44:restarted", launch: { ...initial.launch, processId: 44, startedAt: "after" } };
  await render(fresh);
  expect(control.busy).toBe(false); expect(control.phase).toBeNull();
  const second = await request(); await accept(second.promise);
  expect(transport.send).toHaveBeenNthCalledWith(2, origin + "/api/core/stop", { instance: fresh.instance }, "POST", expect.any(AbortSignal));
});

it.each(["disabled", "missing", "unmanageable"])("never reads or stops Core while the caller is %s", async condition => {
  await render(condition === "missing" ? null : { ...initial, manageable: condition !== "unmanageable" }, origin, condition === "disabled");
  await act(async () => control.stop());
  expect(transport.read).not.toHaveBeenCalled(); expect(transport.send).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
});

it("ignores an obsolete launch read before it can open a confirmation", async () => {
  const read = deferred<Response>(); transport.read.mockReturnValueOnce(read.promise);
  const { promise } = await request();
  const signal = transport.read.mock.calls[0][1].signal as AbortSignal;
  await render(initial, "https://other-core.test");
  expect(signal.aborted).toBe(true); expect(control.busy).toBe(false);
  await act(async () => { read.resolve(Response.json(initial)); await promise; });
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(transport.send).not.toHaveBeenCalled(); expect(transport.info).not.toHaveBeenCalled();
  expect(transport.error).not.toHaveBeenCalled();
});
