// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GatewaySettings } from "./gateway-settings";
import { approveSkill, establishSession, loadSettings, saveSettings, type SettingsResponse } from "../lib/api";

vi.mock("../lib/api", async original => ({
  ...await original<typeof import("../lib/api")>(),
  approveSkill: vi.fn(), establishSession: vi.fn(), loadSettings: vi.fn(), saveSettings: vi.fn(),
}));
vi.mock("./agent-providers", () => ({ AgentProviders: () => null }));

let root: Root;
let container: HTMLDivElement;
let data: SettingsResponse;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  data = {
    settings: { systemPrompt: "", mcpProviders: { "hosty:core": true, projects: true, media: false }, mcpAutoAllow: { "hosty:core": true } },
    providers: [
      { appId: "hosty:core", displayName: "Hosty Core", url: "https://core.example", running: true },
      { appId: "projects", displayName: "Project Manager", url: "https://projects.example", running: true },
      { appId: "media", displayName: "Media Server", url: null, running: false },
    ],
    discovery: "ok",
    agentConnections: true,
    harness: { name: "Claude", capabilities: { autoAllow: true, liveReconfigure: true } },
    pendingSkills: [{ appId: "projects", displayName: "Project Manager", markdown: "Complete updated instructions", approvedDigest: "old" }],
  };
  vi.mocked(establishSession).mockResolvedValue();
  vi.mocked(loadSettings).mockImplementation(async () => structuredClone(data));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
const render = async () => act(async () => root.render(<GatewaySettings section="access" />));
const details = () => container.querySelector<HTMLElement>("#mcp-application-details")!;
async function select(name: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>('nav[aria-label="Select an MCP application"] button')].find(button => button.textContent?.includes(name))!;
  await act(async () => button.click());
}
async function search(value: string) {
  const input = container.querySelector<HTMLInputElement>('[aria-label="Search applications"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("selects and searches applications without changing access or showing another app's instructions", async () => {
  await render();
  expect(details().querySelector("h2")?.textContent).toBe("Hosty Core");
  await select("Project Manager");
  expect(details().textContent).toContain("Complete updated instructions");
  await select("Media Server");
  expect(details().textContent).not.toContain("Complete updated instructions");
  expect(details().querySelector<HTMLButtonElement>('[role="combobox"]')!.disabled).toBe(true);
  await search("projects");
  expect(details().querySelector("h2")?.textContent).toBe("Project Manager");
  await search("missing");
  expect(details().textContent).toContain("No matching applications");
  await search("");
  expect(details().querySelector("h2")?.textContent).toBe("Media Server");
  expect(saveSettings).not.toHaveBeenCalled();
  expect(approveSkill).not.toHaveBeenCalled();
});

it("keeps the saved target when selection changes during a pending save", async () => {
  let resolve!: (value: SettingsResponse) => void;
  vi.mocked(saveSettings).mockReturnValue(new Promise(done => { resolve = done; }));
  await render();
  await select("Project Manager");
  await act(async () => details().querySelector<HTMLButtonElement>('[role="switch"]')!.click());
  expect(saveSettings).toHaveBeenCalledWith({ mcpProviders: { "hosty:core": true, projects: false, media: false } });
  await select("Media Server");
  expect(details().querySelector<HTMLButtonElement>('[role="switch"]')!.disabled).toBe(true);
  data.settings.mcpProviders.projects = false;
  await act(async () => resolve(structuredClone(data)));
  expect(details().querySelector("h2")?.textContent).toBe("Media Server");
  expect(details().querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
  await select("Project Manager");
  expect(details().querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
});

it("restores the confirmed policy and shows failures after a rejected access save", async () => {
  vi.mocked(saveSettings).mockRejectedValue(new Error("Save refused"));
  await render();
  await select("Project Manager");
  await act(async () => details().querySelector<HTMLButtonElement>('[role="switch"]')!.click());
  expect(details().querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("true");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Save refused");
  expect(details().querySelector<HTMLButtonElement>('[role="switch"]')!.disabled).toBe(false);
});

it("keeps pending instructions reviewable during discovery failure and approves the displayed text only", async () => {
  data.providers = data.providers.slice(0, 1);
  data.discovery = "unavailable";
  vi.mocked(approveSkill).mockResolvedValue();
  await render();
  await select("Project Manager");
  expect(container.textContent).toContain("Could not reach Core");
  expect(details().querySelector('[role="switch"]')).toBeNull();
  expect(details().querySelector("pre")?.textContent).toBe("Complete updated instructions");
  data.pendingSkills = [];
  await act(async () => [...details().querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Approve instructions")!.click());
  expect(approveSkill).toHaveBeenCalledWith("projects", "Complete updated instructions");
  expect(details().querySelector("h2")?.textContent).toBe("Hosty Core");
  expect(details().textContent).not.toContain("Complete updated instructions");
});

it("retains harness-specific disabled approvals even for enabled applications", async () => {
  data.harness = { name: "Codex", capabilities: { autoAllow: false } };
  await render();
  expect(details().querySelector<HTMLButtonElement>('[role="combobox"]')!.disabled).toBe(true);
  expect(details().textContent).toContain("Codex harness decides which calls pause");
});
