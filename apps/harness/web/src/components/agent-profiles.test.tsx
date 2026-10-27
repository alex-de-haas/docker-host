// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { AgentProfiles } from "./agent-profiles";
import * as api from "@/lib/profiles-api";
import { listAgentConnections } from "@/lib/assistant-api";
vi.mock("@/lib/profiles-api", () => ({ listProfiles: vi.fn(), profileSkills: vi.fn(), saveProfile: vi.fn(), deleteProfile: vi.fn(), defaultProfile: vi.fn(), connectionModels: vi.fn() }));
vi.mock("@/lib/assistant-api", () => ({ listAgentConnections: vi.fn() }));
let root: Root, container: HTMLDivElement;
const profile = { id: "planner", revision: 2, name: "Planner", description: "Plans", instructions: "Original role", connectionId: null, model: null, reasoningEffort: null, skillIds: [] };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(api.listProfiles).mockResolvedValue({ revision: 4, defaultId: "planner", profiles: [profile] });
  vi.mocked(api.profileSkills).mockResolvedValue({ skills: [] });
  vi.mocked(listAgentConnections).mockResolvedValue({ connections: [], defaultId: null });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.resetAllMocks(); vi.unstubAllGlobals(); });
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === name)!;
it("keeps profiles visible when provider discovery is unavailable", async () => {
  vi.mocked(listAgentConnections).mockRejectedValue(new Error("Worker unavailable"));
  await act(async () => root.render(<AgentProfiles />));
  expect(container.textContent).toContain("Planner"); expect(container.textContent).toContain("Worker unavailable");
  expect(button("Create profile").disabled).toBe(false);
});
it("retains unsaved fields after a stale save and reloads only on explicit request", async () => {
  vi.mocked(api.saveProfile).mockRejectedValue(new Error("Profiles changed. Reload before saving."));
  await act(async () => root.render(<AgentProfiles />));
  await act(async () => button("Edit Planner").click());
  const label = [...document.querySelectorAll("label")].find(l => l.textContent === "Role instructions")!;
  const input = document.getElementById(label.htmlFor) as HTMLTextAreaElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "Unsaved role");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("Save profile").click());
  expect(api.saveProfile).toHaveBeenCalledWith(expect.objectContaining({ name: "Planner", instructions: "Unsaved role" }), 4, "planner");
  expect(input.value).toBe("Unsaved role"); expect(document.body.textContent).toContain("Profiles changed");
  expect(api.listProfiles).toHaveBeenCalledTimes(1);
  await act(async () => button("Reload saved profile").click());
  expect(input.value).toBe("Original role");
});

it("returns keyboard focus to the form opener after cancellation", async () => {
  await act(async () => root.render(<AgentProfiles />));
  const opener = button("Create profile");
  await act(async () => { opener.focus(); opener.click(); });
  await act(async () => button("Cancel").click());
  await vi.waitFor(() => expect(document.activeElement).toBe(opener));
});
