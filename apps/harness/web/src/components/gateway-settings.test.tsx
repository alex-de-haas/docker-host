// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GatewaySettings } from "./gateway-settings";
import { approveSkill, call, loadSettings, saveSettings, type SettingsResponse } from "../lib/api";

vi.mock("../lib/api", async original => ({
  ...await original<typeof import("../lib/api")>(),
  approveSkill: vi.fn(), call: vi.fn(), loadSettings: vi.fn(), saveSettings: vi.fn(),
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
    mcpReviewBaseUrl: "https://core.test/install/agents/hosty.harness",
    instructions: [{ appId: "projects", markdown: "Complete updated instructions", approved: false }],
    agentConnections: true,
    harness: { name: "Claude", capabilities: { autoAllow: true, liveReconfigure: true } },
    pendingSkills: [{ appId: "projects", displayName: "Project Manager", markdown: "Complete updated instructions", approvedDigest: "old" }],
  };
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
  expect(details().textContent).toContain("Refresh tools to load the available actions.");
  await search("projects");
  expect(details().querySelector("h2")?.textContent).toBe("Project Manager");
  await search("missing");
  expect(details().textContent).toContain("No matching applications");
  await search("");
  expect(details().querySelector("h2")?.textContent).toBe("Media Server");
  expect(saveSettings).not.toHaveBeenCalled();
  expect(approveSkill).not.toHaveBeenCalled();
});

it("opens Core review from Harness without a Shell redirect or silent policy mutation", async () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  await render();
  await select("Project Manager");
  expect(details().textContent).toContain("Core permissions and repository checks still apply.");
  expect(details().querySelector('[role="switch"]')).toBeNull();
  expect(details().querySelector("pre")?.textContent).toBe("Complete updated instructions");
  const review = [...details().querySelectorAll("button")].find(button => button.textContent === "Change access and review instructions")!;
  await act(async () => review.click());
  expect(open).toHaveBeenCalledWith("https://core.test/install/agents/hosty.harness/projects", "_blank", "noopener,noreferrer");
  expect(details().querySelector<HTMLAnchorElement>("a")?.href).toBe("https://core.test/install/agents/hosty.harness/projects");
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(loadSettings).toHaveBeenCalledTimes(2);
  expect(container.querySelector('a[target="_top"]')).toBeNull();
  expect(approveSkill).not.toHaveBeenCalled();
  expect(saveSettings).not.toHaveBeenCalled();
});

it("reports discovery failure without exposing legacy skill approvals", async () => {
  data.discovery = "unavailable";
  await render();
  expect(container.textContent).toContain("Could not reach Core");
  expect(container.textContent).not.toContain("Complete updated instructions");
  expect(container.textContent).not.toContain("Approve instructions");
});

it("offers shared write approval controls even when the native adapter has no auto-allow callback", async () => {
  data.harness = { name: "Codex", capabilities: { autoAllow: false } };
  data.toolCatalogs = [{ provider: "hosty:core", identity: "core-1", tools: [{ name: "merge" }] }];
  await render();
  const select = details().querySelector<HTMLSelectElement>('[aria-label="Approval for merge"]')!;
  expect(select.disabled).toBe(false);
  expect([...select.options].map(o => o.text)).toEqual(["Ask", "Run unprompted", "Disabled"]);
});

it("loads tools without selecting or creating a chat", async () => {
  vi.mocked(call).mockResolvedValue(Response.json({ catalogs: [{ provider: "hosty:core", identity: "core", tools: [{ name: "list_apps" }] }] }));
  await render();
  expect(container.querySelector('[aria-label="Tool discovery session"]')).toBeNull();
  const refresh = [...details().querySelectorAll("button")].find(button => button.textContent === "Refresh tools")!;
  await act(async () => refresh.click());
  expect(call).toHaveBeenCalledWith("/settings/tools");
  expect(details().querySelector('[aria-label="Approval for list_apps"]')).not.toBeNull();
  expect(saveSettings).not.toHaveBeenCalled();
});

it("asks the embedder to open review without supplying an assistant identity", async () => {
  const postMessage = vi.fn();
  vi.stubGlobal("parent", { postMessage });
  await render();
  await select("Project Manager");
  const review = [...details().querySelectorAll("button")].find(button => button.textContent === "Change access and review instructions")!;
  await act(async () => review.click());
  expect(postMessage).toHaveBeenCalledExactlyOnceWith({ type: "hosty:request-mcp-review", targetAppId: "projects" }, "*");
  expect(saveSettings).not.toHaveBeenCalled();
});
