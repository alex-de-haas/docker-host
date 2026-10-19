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
  await act(async () => checkbox("I accept compatibility of current data with the selected previous runtimes. No data is restored.").click());
  await act(async () => button("Return selected participants").click());
  expect(button("Return selected participants").disabled).toBe(true);
  await act(async () => checkbox("shell").click());
  await act(async () => button("Return selected participants").click());
  expect(request.mock.calls.filter(([kind]) => kind === "return").map(([, body]) => body.return.apps)).toEqual([["notes"], ["shell"]]);
});

it("requires compatibility acceptance before app-only Return can dispatch", async () => {
  const a = { id: "app-only", phase: "active", apps: ["notes"] };
  request.mockImplementation(async kind => kind === "list" ? [a] : { status: { activation: a }, children: [] });
  await render();
  const labels = [...container.querySelectorAll("label")];
  await act(async () => labels.find(l => l.textContent === "notes")!.querySelector<HTMLInputElement>("input")!.click());
  expect(button("Return selected participants").disabled).toBe(true);
  await act(async () => button("Return selected participants").click());
  expect(request.mock.calls.some(([kind]) => kind === "return")).toBe(false);
  await act(async () => labels.find(l => l.textContent?.includes("I accept compatibility"))!.querySelector<HTMLInputElement>("input")!.click());
  expect(button("Return selected participants").disabled).toBe(false);
  await act(async () => button("Return selected participants").click());
  expect(request.mock.calls.find(([kind]) => kind === "return")![1]).toMatchObject({
    activationId: "app-only", return: { apps: ["notes"], core: false, acceptDataChanges: true },
  });
});


it("retains an accepted apply across remount for exact preparation retry without blocking status or Return", async () => {
  let a: { id: string; phase: string; apps: string[] } | null = null;
  const base = request.getMockImplementation()!;
  request.mockImplementation(async (kind, body, signal) => {
    if (kind === "list") return a ? [a] : [];
    if (kind === "apply") { a = { id: body.requestId, phase: "prepared", apps: ["notes"] }; return {}; }
    if (kind === "status") return { status: { activation: a!, helper: { state: a?.phase === "preparing" ? "failed" : "accepted" } }, children: [] };
    return base(kind, body, signal);
  });
  await render(); await act(async () => button("Review selection").click());
  await act(async () => button("Apply reviewed selection").click());
  const original = request.mock.calls.find(([kind]) => kind === "apply")![1];
  expect(localStorage.getItem("test:v1")).toBeNull();
  expect(JSON.parse(localStorage.getItem("test:applies:v1")!)[original.requestId].body).toEqual(original);
  expect(button("Refresh status").disabled).toBe(false);
  const returnNotes = [...container.querySelectorAll("label")].find(l => l.textContent === "notes")!.querySelector<HTMLInputElement>("input")!;
  expect(returnNotes.closest("fieldset")!.disabled).toBe(false);
  a = { ...a!, phase: "preparing" };
  await act(async () => root.unmount()); root = createRoot(container); await render();
  expect(button("Resume original activation")).toBeUndefined();
  expect(button("Review preparation again").disabled).toBe(false);
  await act(async () => button("Retry original preparation").click());
  expect(request.mock.calls.filter(([kind]) => kind === "apply").map(([, body]) => body)).toEqual([original, original]);
});

it("explicitly re-reviews repaired source using the retained ID and exact selection", async () => {
  let a: { id: string; phase: string; apps: string[] } | null = null, repaired = false;
  const base = request.getMockImplementation()!;
  request.mockImplementation(async (kind, body, signal) => {
    if (kind === "list") return a ? [a] : [];
    if (kind === "plan") { const value = await base(kind, body, signal); return repaired ? { ...value, planDigest: "repaired-review" } : value; }
    if (kind === "apply") {
      if (repaired && body.planDigest !== "repaired-review") throw Object.assign(new Error("Source changed. Review again."), { code: "activation_review_changed" });
      a = { id: body.requestId, phase: "prepared", apps: ["notes"] }; return {};
    }
    if (kind === "status") return { status: { activation: a!, helper: { state: "failed" } }, children: [] };
    return base(kind, body, signal);
  });
  await render(); await act(async () => button("Review selection").click());
  await act(async () => button("Apply reviewed selection").click());
  const original = request.mock.calls.find(([kind]) => kind === "apply")![1];
  a = { ...a!, phase: "preparing" }; repaired = true;
  await act(async () => root.unmount()); root = createRoot(container); await render();
  await act(async () => button("Retry original preparation").click());
  expect(container.textContent).toContain("Source changed. Review again.");
  expect(button("Retry original request")).toBeUndefined();
  expect(JSON.parse(localStorage.getItem("test:applies:v1")!)[original.requestId].body).toEqual(original);
  await act(async () => button("Review preparation again").click());
  expect(request.mock.calls.filter(([kind]) => kind === "plan").at(-1)![1]).toEqual({ selection: original.selection });
  expect(request.mock.calls.filter(([kind]) => kind === "apply")).toHaveLength(2);
  const participantInputs = [...container.querySelectorAll("fieldset")].find(f => f.querySelector("legend")?.textContent === "Participants")!;
  expect([...participantInputs.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].every(input => input.disabled)).toBe(true);
  await act(async () => button("Retry reviewed preparation").click());
  expect(request.mock.calls.filter(([kind]) => kind === "apply").at(-1)![1]).toEqual({ ...original, planDigest: "repaired-review" });
});

it("retries an uncertain re-preparation with its exact refreshed review after remount", async () => {
  const original = { requestId: "original-activation", selection: { coreSelected: false, apps: [{ appId: "notes", selected: true, worktreeId: "tree", runtime: "dev" }] }, planDigest: "old-review" };
  localStorage.setItem("test:applies:v1", JSON.stringify({ [original.requestId]: { kind: "apply", body: original } }));
  const a = { id: original.requestId, phase: "preparing", apps: ["notes"] };
  request.mockImplementation(async kind => {
    if (kind === "list") return [a];
    if (kind === "plan") return { ...review, planDigest: "new-review" };
    if (kind === "apply") throw new Error("response lost");
    return { status: { activation: a, helper: { state: "failed" } }, children: [] };
  });
  await render(); await act(async () => button("Review preparation again").click());
  await act(async () => button("Retry reviewed preparation").click());
  const refreshed = { ...original, planDigest: "new-review" };
  expect(JSON.parse(localStorage.getItem("test:v1")!).body).toEqual(refreshed);
  expect(JSON.parse(localStorage.getItem("test:applies:v1")!)[original.requestId].body).toEqual(original);
  await act(async () => root.unmount()); root = createRoot(container); await render();
  expect(button("Review preparation again").disabled).toBe(true);
  await act(async () => button("Retry original request").click());
  expect(request.mock.calls.filter(([kind]) => kind === "apply").map(([, body]) => body)).toEqual([refreshed, refreshed]);
});

it("recovers the original apply body observed after its acceptance response was lost", async () => {
  let accepted = false;
  const original = { requestId: "accepted-activation", selection: { coreSelected: false }, planDigest: "review" };
  localStorage.setItem("test:v1", JSON.stringify({ kind: "apply", body: original }));
  const a = { id: original.requestId, phase: "preparing", apps: ["notes"] };
  request.mockImplementation(async kind => {
    if (kind === "list") return [a];
    if (kind === "apply") { accepted = true; return {}; }
    return { status: { activation: a, helper: { state: "failed" } }, children: [] };
  });
  await render();
  expect(JSON.parse(localStorage.getItem("test:applies:v1")!)[original.requestId].body).toEqual(original);
  await act(async () => button("Retry original request").click());
  expect(accepted).toBe(true);
  expect(button("Retry original request")).toBeUndefined();
  expect(button("Retry original preparation").disabled).toBe(false);
});


it("replays the selected retained activation rather than another accepted request", async () => {
  const first = { requestId: "first-activation", selection: { coreSelected: false, apps: [{ appId: "notes", selected: true }] }, planDigest: "first-review" };
  const second = { requestId: "second-activation", selection: { coreSelected: true }, planDigest: "second-review" };
  localStorage.setItem("test:applies:v1", JSON.stringify(Object.fromEntries([first, second].map(body => [body.requestId, { kind: "apply", body }]))));
  const activations = [first, second].map(body => ({ id: body.requestId, phase: "preparing", apps: ["notes"] }));
  request.mockImplementation(async (kind, body) => kind === "list" ? activations : kind === "apply" ? {}
    : { status: { activation: activations.find(a => a.id === body.activationId) }, children: [] });
  await render();
  const retained = [...container.querySelectorAll("label")].find(l => l.textContent?.startsWith("Retained activation"))!.querySelector("select")!;
  await act(async () => { retained.value = first.requestId; retained.dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => button("Retry original preparation").click());
  expect(request.mock.calls.filter(([kind]) => kind === "apply").map(([, body]) => body)).toEqual([first]);
});


it.each(["returned", "cancelled"])("clears confirmed apply metadata after %s while preserving an uncertain request", async phase => {
  const original = { requestId: "finished-activation", selection: { coreSelected: false }, planDigest: "review" };
  const uncertain = { kind: "return", body: { activationId: original.requestId, return: { requestId: "original-return", apps: ["notes"], core: false, acceptDataChanges: true } } };
  localStorage.setItem("test:applies:v1", JSON.stringify({ [original.requestId]: { kind: "apply", body: original } }));
  localStorage.setItem("test:v1", JSON.stringify(uncertain));
  const a = { id: original.requestId, phase, apps: ["notes"] };
  request.mockImplementation(async kind => kind === "list" ? [a] : kind === "return" ? {} : { status: { activation: a }, children: [] });
  await render();
  expect(localStorage.getItem("test:applies:v1")).toBeNull();
  expect(JSON.parse(localStorage.getItem("test:v1")!)).toEqual(uncertain);
  await act(async () => button("Retry original request").click());
  expect(request.mock.calls.find(([kind]) => kind === "return")![1]).toEqual(uncertain.body);
  expect(localStorage.getItem("test:v1")).toBeNull();
});


it.each(["notes", "Core — captured previous executable"])("requires fresh compatibility acceptance after switching retained activations for %s", async participant => {
  const activations = ["first-activation", "second-activation"].map(id => ({ id, phase: "active", apps: ["notes"], coreProject: "Core.csproj" }));
  request.mockImplementation(async (kind, body) => kind === "list" ? activations : kind === "return" ? {}
    : { status: { activation: activations.find(a => a.id === body.activationId) }, children: [] });
  await render();
  const checkbox = (text: string) => [...container.querySelectorAll("label")].find(l => l.textContent === text)!.querySelector<HTMLInputElement>("input")!;
  const acceptance = "I accept compatibility of current data with the selected previous runtimes. No data is restored.";
  const selectActivation = async (id: string) => act(async () => {
    const retained = [...container.querySelectorAll("label")].find(l => l.textContent?.startsWith("Retained activation"))!.querySelector("select")!;
    retained.value = id; retained.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => checkbox(participant).click());
  await act(async () => checkbox(acceptance).click());
  expect(button("Return selected participants").disabled).toBe(false);
  await selectActivation("first-activation");
  expect(checkbox(acceptance).checked).toBe(false);
  await act(async () => checkbox(participant).click());
  expect(button("Return selected participants").disabled).toBe(true);
  await act(async () => button("Return selected participants").click());
  expect(request.mock.calls.some(([kind]) => kind === "return")).toBe(false);
  await act(async () => checkbox(acceptance).click());
  expect(button("Return selected participants").disabled).toBe(false);
  await selectActivation("second-activation");
  expect(checkbox(acceptance).checked).toBe(false);
  await act(async () => checkbox(participant).click());
  expect(button("Return selected participants").disabled).toBe(true);
  await act(async () => checkbox(acceptance).click());
  await act(async () => button("Return selected participants").click());
  expect(request.mock.calls.find(([kind]) => kind === "return")![1]).toMatchObject({ activationId: "second-activation", return: { acceptDataChanges: true } });
});

it("requires fresh compatibility acceptance when applying a new activation changes the current ID", async () => {
  const original = { id: "original-activation", phase: "active", apps: ["notes"] };
  let current = original;
  const base = request.getMockImplementation()!;
  request.mockImplementation(async (kind, body, signal) => {
    if (kind === "list") return current === original ? [original] : [original, current];
    if (kind === "apply") { current = { ...original, id: body.requestId }; return {}; }
    if (kind === "status") return { status: { activation: body.activationId === original.id ? original : current }, children: [] };
    return base(kind, body, signal);
  });
  await render();
  const checkbox = (text: string) => [...container.querySelectorAll("label")].find(l => l.textContent === text)!.querySelector<HTMLInputElement>("input")!;
  const acceptance = "I accept compatibility of current data with the selected previous runtimes. No data is restored.";
  await act(async () => checkbox("notes").click());
  await act(async () => checkbox(acceptance).click());
  expect(button("Return selected participants").disabled).toBe(false);
  await act(async () => button("Review selection").click());
  await act(async () => button("Apply reviewed selection").click());
  expect(current.id).not.toBe(original.id);
  expect(checkbox(acceptance).checked).toBe(false);
  expect(button("Return selected participants").disabled).toBe(true);
  await act(async () => checkbox(acceptance).click());
  expect(button("Return selected participants").disabled).toBe(false);
});


it("keeps the reviewed activation selected while review and apply responses are pending", async () => {
  const first = { requestId: "first-activation", selection: { coreSelected: false, apps: [{ appId: "notes", selected: true }] }, planDigest: "original-review" };
  const second = { requestId: "second-activation", selection: { coreSelected: false, apps: [{ appId: "other", selected: true }] }, planDigest: "other-review" };
  localStorage.setItem("test:applies:v1", JSON.stringify(Object.fromEntries([first, second].map(body => [body.requestId, { kind: "apply", body }]))));
  const activations = [second, first].map(body => ({ id: body.requestId, phase: "preparing", apps: body.selection.apps.map(app => app.appId) }));
  let completeReview!: (value: unknown) => void, completeApply!: (value: unknown) => void;
  const pendingReview = new Promise(resolve => { completeReview = resolve; });
  const pendingApply = new Promise(resolve => { completeApply = resolve; });
  request.mockImplementation(async (kind, body) => kind === "list" ? activations : kind === "plan" ? pendingReview : kind === "apply" ? pendingApply
    : { status: { activation: activations.find(a => a.id === body.activationId) }, children: [] });
  await render();
  const retained = () => [...container.querySelectorAll("label")].find(l => l.textContent?.startsWith("Retained activation"))!.querySelector("select")!;
  const attemptSwitch = async () => act(async () => { retained().value = second.requestId; retained().dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => button("Review preparation again").click());
  expect(retained().disabled).toBe(true);
  await attemptSwitch();
  expect(retained().value).toBe(first.requestId);
  await act(async () => completeReview({ ...review, planDigest: "fresh-review" }));
  expect(retained().disabled).toBe(false);
  expect(retained().value).toBe(first.requestId);
  await act(async () => button("Retry reviewed preparation").click());
  expect(retained().disabled).toBe(true);
  await attemptSwitch();
  expect(retained().value).toBe(first.requestId);
  await act(async () => completeApply({}));
  expect(retained().disabled).toBe(false);
  expect(request.mock.calls.find(([kind]) => kind === "apply")![1]).toEqual({ ...first, planDigest: "fresh-review" });
});
