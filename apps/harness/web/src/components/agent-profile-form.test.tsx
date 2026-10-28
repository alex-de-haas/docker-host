// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { AgentProfileForm } from "./agent-profile-form";
import { connectionModels, type AgentProfileConfig } from "@/lib/profiles-api";
vi.mock("@/lib/profiles-api", () => ({ connectionModels: vi.fn() }));
let root: Root, container: HTMLDivElement;
const change = vi.fn();
const config: AgentProfileConfig = { name: "Developer", description: "General developer", instructions: "Role text", connectionId: "a", model: "one", reasoningEffort: "high", skillIds: ["skill-a"] };
const connections = [{ id: "a", name: "Claude", kind: "claude", revision: 1, auth: "api-key", available: true }, { id: "b", name: "Codex", kind: "codex", revision: 1, auth: "api-key", available: true }] as const;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  vi.mocked(connectionModels).mockResolvedValue({ revision: "one", models: [{ id: "one", label: "One", efforts: [{ id: "high", label: "High" }] }] }); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.resetAllMocks(); vi.unstubAllGlobals(); });
const render = (skillsError?: string) => act(async () => root.render(<AgentProfileForm value={config} onChange={change} connections={[...connections]} defaultConnectionId="a" skills={[{ id: "skill-a", name: "Next.js", description: "Build applications" }, { id: "skill-b", name: ".NET", description: "Build services" }]} skillsError={skillsError} />));
function input(label: string) { const node = [...container.querySelectorAll("label")].find(n => n.textContent === label)!; return document.getElementById(node.htmlFor) as HTMLSelectElement; }
it("clears provider-specific model and effort together when the connection is changed", async () => {
  await render(); await act(async () => { const node = input("Agent connection"); node.value = "b"; node.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(change).toHaveBeenCalledWith({ ...config, connectionId: "b", model: null, reasoningEffort: null });
});
it("makes the skill set explicit and retains selections when the catalog is unavailable", async () => {
  await render(); const checks = container.querySelectorAll<HTMLButtonElement>('[role="checkbox"]');
  expect(checks[0]?.getAttribute("data-state")).toBe("checked");
  await act(async () => checks[1]!.click()); expect(change).toHaveBeenCalledWith({ ...config, skillIds: ["skill-a", "skill-b"] });
  change.mockClear(); await render("Catalog offline."); expect(container.textContent).toContain("Existing selections are retained."); expect(change).not.toHaveBeenCalled();
});
it("preserves the form when model discovery fails and gives a retry action", async () => {
  vi.mocked(connectionModels).mockRejectedValue(new Error("Worker offline")); await render();
  expect(container.textContent).toContain("Worker offline"); expect((input("Name") as unknown as HTMLInputElement).value).toBe("Developer"); expect(change).not.toHaveBeenCalled();
  const retry = [...container.querySelectorAll<HTMLButtonElement>("button")].find(n => n.textContent === "Retry models")!;
  await act(async () => retry.click()); expect(connectionModels).toHaveBeenCalledTimes(2);
});

it("shows Core provenance and keeps platform guidance included while app development remains selectable", async () => {
  await act(async () => root.render(<AgentProfileForm value={config} onChange={change} connections={[...connections]} defaultConnectionId="a" skills={[
    { id: "platform", name: "hosty-platform", description: "Operate Hosty", sourceKind: "core", coreVersion: "1.2.3", introductionPath: "references/introduction.md" },
    { id: "development", name: "hosty-app-skill", description: "Build apps", sourceKind: "core", coreVersion: "1.2.3" },
  ]} />));
  const checks = container.querySelectorAll<HTMLButtonElement>('[role="checkbox"]');
  expect(checks[0]?.disabled).toBe(true); expect(checks[0]?.getAttribute("data-state")).toBe("checked");
  expect(checks[1]?.disabled).toBe(false); expect(checks[1]?.getAttribute("data-state")).toBe("unchecked");
  expect(container.textContent).toContain("Core · 1.2.3 · Included for every agent");
  await act(async () => checks[1]!.click());
  expect(change).toHaveBeenCalledWith({ ...config, skillIds: ["skill-a", "development"] });
});

it("shows incompatible Ollama models with the server reason and preserves exact tags", async () => {
  vi.mocked(connectionModels).mockResolvedValue({revision:"ollama",models:[
    {id:"qwen:27b",label:"qwen:27b",efforts:[{id:"false",label:"Off"}]},
    {id:"embed:latest",label:"embed:latest",efforts:[],unavailableReason:"No tool support"}
  ]});
  await render();
  const options=[...container.querySelectorAll("option")];
  expect(options.find(o=>o.value==="qwen:27b")?.disabled).toBe(false);
  expect(options.find(o=>o.value==="embed:latest")).toMatchObject({disabled:true});
  expect(container.textContent).toContain("No tool support");
});
