// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { McpAccess } from "./mcp-access";
import { ApiError, call, loadSettings, type SettingsResponse } from "../lib/api";
vi.mock("../lib/api", async original => ({ ...await original<typeof import("../lib/api")>(), call: vi.fn(), loadSettings: vi.fn() }));
let root: Root, container: HTMLDivElement, data: SettingsResponse;
const refresh = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  data = {
    settings: { systemPrompt: "", mcpProviders: {}, mcpAutoAllow: {}, mcpDefaults: {}, mcpToolRules: {}, mcpSkillApprovals: {} },
    providers: [{ appId: "notes", displayName: "Notes", url: "http://notes/mcp", running: true, offered: true, deniedTools: [] },
      { appId: "media", displayName: "Media", url: "http://media/mcp", running: true, offered: false, deniedTools: [] }],
    accessRevision: "access-one", mcpRevision: "local-one", discovery: "ok", agentConnections: true,
    harness: { name: "Claude", capabilities: { autoAllow: true, liveReconfigure: true } },
    toolCatalogs: [{ provider: "notes", identity: "notes-1", tools: [{ name: "read" }, { name: "delete" }] }, { provider: "media", identity: "media-1", tools: [{ name: "play" }] }],
    instructions: [{ appId: "notes", identity: "notes-1", digest: "content-1", markdown: "Reviewed notes guidance", approved: false }],
  };
  vi.mocked(loadSettings).mockImplementation(async () => structuredClone(data));
  vi.mocked(call).mockImplementation(async (url) => Response.json(url === "/settings/tools" ? { catalogs: data.toolCatalogs } : url === "/settings/mcp/review" ? { id: "review", status: "succeeded", approvalUrl: "https://core.test/install/confirm/review" } : {}));
  vi.spyOn(window, "open").mockReturnValue(null); refresh.mockResolvedValue(undefined);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllGlobals(); });
const render = async () => {
  await act(async () => root.render(<McpAccess data={data} busy={false} error={null} status={null} feedbackAppId={null} onRefresh={refresh} onSave={vi.fn()} />));
  vi.mocked(call).mockClear();
};
const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.includes(text))!;
const click = (node: HTMLElement) => act(async () => node.click());
const save = () => click(button("Save"));

it("keeps access edits as a draft and submits one Core batch before local preferences", async () => {
  await render(); await click(container.querySelector('[aria-label="Allow Media"]')!);
  await click(button("Notes")); await click(container.querySelector('#tool-notes-delete')!);
  expect(call).not.toHaveBeenCalled(); await save();
  expect(vi.mocked(call).mock.calls.map(args => args[0])).toEqual(["/settings/mcp/review", "/settings/mcp/preferences"]);
  const input = JSON.parse(vi.mocked(call).mock.calls[0]![1]!.body as string);
  expect(input.targets).toEqual([{ targetId: "notes", enabled: true, deniedTools: ["delete"] }, { targetId: "media", enabled: true, deniedTools: [] }]);
  expect(input).not.toHaveProperty("assistantId"); expect(input.requestId).toBeTruthy();
});
it("preserves the draft when Core refuses and does not save invocation preferences", async () => {
  vi.mocked(call).mockImplementation(async url => Response.json(url === "/settings/tools" ? { catalogs: data.toolCatalogs } : { id: "review", status: "denied" }));
  await render(); await click(container.querySelector('[aria-label="Allow Media"]')!); await save();
  expect(call).toHaveBeenCalledTimes(1); expect(container.textContent).toContain("draft is preserved");
  expect(container.querySelector('[aria-label="Allow Media"]')?.getAttribute("data-state")).toBe("checked");
});
it("retries local failure without asking Core to approve the saved access again", async () => {
  let fail = true;
  vi.mocked(call).mockImplementation(async url => {
    if (url === "/settings/tools") return Response.json({ catalogs: data.toolCatalogs });
    if (url === "/settings/mcp/review") return Response.json({ id: "review", status: "succeeded" });
    if (fail) { fail = false; throw new Error("Local storage unavailable"); } return Response.json({});
  });
  await render(); await click(container.querySelector('[aria-label="Allow Media"]')!); await save();
  expect(container.textContent).toContain("Local storage unavailable"); await save();
  expect(vi.mocked(call).mock.calls.filter(args => args[0] === "/settings/mcp/review")).toHaveLength(1);
});
it("accepts reviewed application instructions in Harness without a Core request", async () => {
  await render(); await click(button("Notes"));
  const controls = [...container.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')];
  const acceptance = controls.find(node => node.id.startsWith("instructions-")) ?? controls[controls.length - 1]!;
  await click(acceptance); await save();
  expect(vi.mocked(call).mock.calls.map(args => args[0])).toEqual(["/settings/mcp/preferences"]);
  expect(JSON.parse(vi.mocked(call).mock.calls[0]![1]!.body as string).skills.notes).toEqual({ identity: "notes-1", digest: "content-1" });
});
it("explains future-tool availability once, on demand", async () => {
  await render(); expect(container.textContent).not.toContain("New tools from enabled");
  await click(container.querySelector('[aria-label="About new tools"]')!);
  expect(document.body.textContent).toContain("New tools from enabled applications become available automatically");
  expect(document.querySelectorAll('[data-slot="popover-content"]')).toHaveLength(1);
});
it("keeps unavailable tool denials when enabling the application's current catalog", async () => {
  data.providers[0]!.deniedTools = ["removed_tool", "delete"];
  await render(); await click(container.querySelector('[aria-label="Allow Notes"]')!); await save();
  const input = JSON.parse(vi.mocked(call).mock.calls[0]![1]!.body as string);
  expect(input.targets).toEqual([{ targetId: "notes", enabled: true, deniedTools: ["removed_tool"] }]);
});

it("refreshes a stale access revision without discarding the draft or overwriting concurrent choices", async () => {
  let refused = true;
  vi.mocked(call).mockImplementation(async url => {
    if (url === "/settings/tools") return Response.json({ catalogs: data.toolCatalogs });
    if (url === "/settings/mcp/review") {
      if (refused) { refused = false; throw new ApiError(409, "agent_policy_changed", "Refresh tools and review again."); }
      return Response.json({ id: "new-review", status: "succeeded" });
    }
    return Response.json({});
  });
  await render(); await click(container.querySelector('[aria-label="Allow Media"]')!); await save();
  const original = JSON.parse(vi.mocked(call).mock.calls[0]![1]!.body as string);
  data = { ...data, accessRevision: "access-two", providers: data.providers.map(p => p.appId === "notes" ? { ...p, deniedTools: ["delete"] } : p) };
  await click(button("Refresh tools"));
  expect(container.querySelector('[aria-label="Allow Media"]')?.getAttribute("data-state")).toBe("checked");
  await save();
  const calls = vi.mocked(call).mock.calls.filter(args => args[0] === "/settings/mcp/review");
  const retried = JSON.parse(calls[1]![1]!.body as string);
  expect(retried.revision).toBe("access-two"); expect(retried.requestId).not.toBe(original.requestId);
  expect(retried.targets).toEqual([{ targetId: "media", enabled: true, deniedTools: [] }]);
});

it("shows legacy disabled built-in tools and reenables them locally without Core review", async () => {
  data.toolCatalogs!.push({ provider: "hosty:development", identity: "development-1", tools: [{ name: "edit_file" }] });
  const key = JSON.stringify(["hosty:development", "edit_file"]);
  data.settings.mcpToolRules![key] = { identity: "development-1", mode: "disabled" };
  await render(); expect(button("Development tools").textContent).toContain("0/1");
  await click(button("Development tools"));
  const toggle = document.getElementById("tool-hosty:development-edit_file")!;
  expect(toggle.getAttribute("data-state")).toBe("unchecked");
  expect(container.querySelector('[aria-label="Approval for edit_file"]')?.hasAttribute("disabled")).toBe(true);
  await click(toggle); await save();
  expect(vi.mocked(call).mock.calls.map(args => args[0])).toEqual(["/settings/mcp/preferences"]);
  expect(JSON.parse(vi.mocked(call).mock.calls[0]![1]!.body as string).removeRules).toContain(key);
});
it("disables a built-in tool through the local preferences save", async () => {
  data.toolCatalogs!.push({ provider: "hosty:development", identity: "development-1", tools: [{ name: "edit_file" }] });
  await render(); await click(button("Development tools"));
  await click(document.getElementById("tool-hosty:development-edit_file")!); await save();
  expect(vi.mocked(call).mock.calls.map(args => args[0])).toEqual(["/settings/mcp/preferences"]);
  expect(JSON.parse(vi.mocked(call).mock.calls[0]![1]!.body as string).rules).toEqual({
    '["hosty:development","edit_file"]': { identity: "development-1", mode: "disabled" },
  });
});


it("keeps overlapping access edits on their reviewed base until explicitly discarded", async () => {
  await render(); await click(container.querySelector('[aria-label="Allow Media"]')!);
  data = { ...data, accessRevision: "access-two", providers: data.providers.map(p => p.appId === "media" ? { ...p, deniedTools: ["play"] } : p) };
  await click(button("Refresh tools"));
  expect(container.textContent).toContain("changed in another client");
  expect(container.querySelector('[aria-label="Allow Media"]')?.getAttribute("data-state")).toBe("checked");
  vi.mocked(call).mockImplementation(async () => { throw new ApiError(409, "agent_policy_changed", "Conflict"); });
  await save();
  const input = JSON.parse(vi.mocked(call).mock.calls.find(args => args[0] === "/settings/mcp/review")![1]!.body as string);
  expect(input.revision).toBe("access-one");
  await click(button("Discard"));
  expect(container.querySelector('[aria-label="Allow Media"]')?.getAttribute("data-state")).toBe("unchecked");
  await click(container.querySelector('[aria-label="Allow Media"]')!); await save();
  const calls = vi.mocked(call).mock.calls.filter(args => args[0] === "/settings/mcp/review");
  expect(JSON.parse(calls.at(-1)![1]!.body as string).revision).toBe("access-two");
});

it("keeps overlapping local tool edits on their original preference revision", async () => {
  data.toolCatalogs!.push({ provider: "hosty:development", identity: "development-1", tools: [{ name: "edit_file" }] });
  const key = JSON.stringify(["hosty:development", "edit_file"]);
  await render(); await click(button("Development tools"));
  await click(document.getElementById("tool-hosty:development-edit_file")!);
  data = { ...data, mcpRevision: "local-two", settings: { ...data.settings, mcpToolRules: { [key]: { identity: "development-1", mode: "run" } } } };
  await click(button("Refresh tools"));
  expect(container.textContent).toContain("changed in another client");
  await save();
  const input = JSON.parse(vi.mocked(call).mock.calls.find(args => args[0] === "/settings/mcp/preferences")![1]!.body as string);
  expect(input.revision).toBe("local-one");
  expect(input.rules[key].mode).toBe("disabled");
});


it("detects new concurrent exceptions when applying a provider-wide preference", async () => {
  await render();
  const select = container.querySelector<HTMLElement>('[aria-label="Approval for Notes"]')!;
  await act(async () => select.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(node => node.textContent === "Do not ask")!;
  await click(option);
  data = { ...data, mcpRevision: "local-two", settings: { ...data.settings, mcpToolRules: { '["notes","read"]': { identity: "notes-1", mode: "ask" } } } };
  await click(button("Refresh tools"));
  expect(container.textContent).toContain("changed in another client");
  await save();
  const input = JSON.parse(vi.mocked(call).mock.calls.find(args => args[0] === "/settings/mcp/preferences")![1]!.body as string);
  expect(input.revision).toBe("local-one");
  expect(input.resetProviders).toEqual(["notes"]);
});


it("discard after a local failure retains access already approved in Core", async () => {
  vi.mocked(call).mockImplementation(async url => {
    if (url === "/settings/tools") return Response.json({ catalogs: data.toolCatalogs });
    if (url === "/settings/mcp/review") return Response.json({ id: "review", status: "succeeded" });
    throw new Error("Local storage unavailable");
  });
  await render(); await click(container.querySelector('[aria-label="Allow Media"]')!); await save();
  await click(button("Discard"));
  expect(container.querySelector('[aria-label="Allow Media"]')?.getAttribute("data-state")).toBe("checked");
  expect(button("Save").disabled).toBe(true);
});
