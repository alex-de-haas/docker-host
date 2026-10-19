// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspaceActivationPanel } from "../../../../../shared/web/workspace-activation";
let root: Root, container: HTMLDivElement;
const request = vi.fn();
const participants = [
  { id: "notes", kind: "app", name: "Notes", selected: true, reason: "explicit-app-binding", worktreeId: "tree", availableRuntimes: ["dev"], targetRuntime: "dev" },
  { id: "hosty:core", kind: "core", name: "Core", selected: true, reason: "configured-repository-match", worktreeId: "tree", availableRuntimes: ["dev"], targetRuntime: "dev" },
];
const review = { plan: { coreInstance: "123:started", participants }, planDigest: "review", consequences: ["Ordinary users and data", "Core interruption"] };
const button = (text: string) => [...container.querySelectorAll("button")].find(b => b.textContent === text)!;
beforeEach(() => {
  localStorage.clear(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  request.mockImplementation(async (kind, body) => kind === "list" ? [] : kind === "plan" ? { ...review, plan: { ...review.plan, participants: participants.map(p => ({ ...p, selected: p.kind === "core" ? body.selection.coreSelected : true })) } }
    : kind === "status" ? { status: { activation: { id: body.activationId, phase: "prepared", apps: ["notes"] }, helper: { state: "accepted" } }, children: [] } : {});
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); request.mockReset(); });
const render = () => act(async () => root.render(<WorkspaceActivationPanel workspaceId="workspace" request={request} storageKey="test" />));
it("invalidates review on Core deselection and applies only the reviewed choices", async () => {
  await render(); await act(async () => button("Review selection").click());
  expect(container.textContent).toContain("Matches configured Core repository");
  const core = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]!;
  await act(async () => core.click());
  expect(button("Apply reviewed selection")).toBeUndefined();
  await act(async () => button("Review selection").click());
  await act(async () => button("Apply reviewed selection").click());
  const call = request.mock.calls.find(([kind]) => kind === "apply")!;
  expect(call[1]).toMatchObject({ selection: { coreSelected: false, apps: [{ appId: "notes", selected: true }] }, planDigest: "review" });
  expect(call[1].requestId).toMatch(/^[0-9a-f-]{36}$/);
});
it("retains the exact apply request across response loss and remount", async () => {
  await render(); await act(async () => button("Review selection").click());
  const base = request.getMockImplementation()!;
  request.mockImplementation(async (kind, body, signal) => { if (kind === "apply") throw new Error("response lost"); return base(kind, body, signal); });
  await act(async () => button("Apply reviewed selection").click());
  const original = request.mock.calls.find(([kind]) => kind === "apply")![1];
  await act(async () => root.unmount()); root = createRoot(container); await render();
  await act(async () => button("Retry original request").click());
  expect(request.mock.calls.filter(([kind]) => kind === "apply").map(([, body]) => body)).toEqual([original, original]);
});
it("requires explicit compatibility acceptance for Core Return", async () => {
  const a = { id: "retained", phase: "active", apps: ["notes"], coreProject: "Core.csproj" };
  request.mockImplementation(async kind => kind === "list" ? [a] : { status: { activation: a }, children: [] });
  await render();
  const labels = [...container.querySelectorAll("label")];
  const core = labels.find(l => l.textContent?.includes("Core —"))!.querySelector<HTMLInputElement>("input")!;
  await act(async () => core.click()); expect(button("Return selected participants").disabled).toBe(true);
  const acceptance = labels.find(l => l.textContent?.includes("I accept compatibility"))!.querySelector<HTMLInputElement>("input")!;
  await act(async () => acceptance.click()); expect(button("Return selected participants").disabled).toBe(false);
  await act(async () => button("Return selected participants").click());
  expect(request.mock.calls.find(([kind]) => kind === "return")![1]).toMatchObject({ activationId: "retained", return: { apps: [], core: true, acceptDataChanges: true } });
});

it("keeps a stale-review refusal visible without polling an unadmitted operation", async () => {
  await render(); await act(async () => button("Review selection").click());
  const base = request.getMockImplementation()!;
  request.mockImplementation(async (kind, body, signal) => {
    if (kind === "apply") throw Object.assign(new Error("Source changed. Review again."), { code: "activation_review_changed" });
    if (kind === "status") throw new Error("The workspace activation record is unavailable.");
    return base(kind, body, signal);
  });
  await act(async () => button("Apply reviewed selection").click());
  expect(container.textContent).toContain("Source changed. Review again.");
  expect(container.textContent).not.toContain("Reconnecting:");
  expect(button("Retry original request")).toBeUndefined();
  expect(button("Review selection").disabled).toBe(false);
  expect(localStorage.getItem("test:v1")).toBeNull();
});


it("excludes returned participants from the next Return without remounting", async () => {
  let a = { id: "retained", phase: "active", apps: ["notes", "shell"], returnedApps: [] as string[], coreProject: "Core.csproj" };
  request.mockImplementation(async (kind, body) => {
    if (kind === "list") return [a];
    if (kind === "return") { a = { ...a, returnedApps: [...a.returnedApps, ...body.return.apps] }; return {}; }
    return { status: { activation: a }, children: [] };
  });
  await render();
  const checkbox = (text: string) => [...container.querySelectorAll("label")].find(l => l.textContent === text)!.querySelector<HTMLInputElement>("input")!;
  await act(async () => checkbox("notes").click());
  await act(async () => button("Return selected participants").click());
  expect(button("Return selected participants").disabled).toBe(true);
  await act(async () => checkbox("shell").click());
  await act(async () => button("Return selected participants").click());
  expect(request.mock.calls.filter(([kind]) => kind === "return").map(([, body]) => body.return.apps)).toEqual([["notes"], ["shell"]]);
});
