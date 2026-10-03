import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsAgentsSection } from "../src/app/shell/pages/settings-agents-section";
import { AuthRequiredRedirectError, redirectToCoreLoginIfAuthRequired } from "../src/app/shell/core-api";
vi.mock("../src/app/shell/core-api", async importOriginal => ({
  ...await importOriginal<typeof import("../src/app/shell/core-api")>(),
  redirectToCoreLoginIfAuthRequired: vi.fn(),
}));
let root: Root; let container: HTMLDivElement;
const directory = { revision: "revision-reviewed", targets: [{ id: "notes", displayName: "Notes", offered: false, runtimeState: "running",
  interfaces: [{ key: "default", readiness: "ready" }], skills: [{ key: "agent", digest: "new", approvedDigest: "old", markdown: "Entire reviewed text" }] }] };
const send = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(directory)));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  send.mockImplementation(async () => Response.json(directory));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.resetAllMocks(); vi.unstubAllGlobals(); });
const render = () => act(async () => root.render(<SettingsAgentsSection coreOrigin="https://core.test" sendCsrfJson={send} />));
it("offers tools independently of instruction approval", async () => {
  await render();
  await act(async () => container.querySelector<HTMLInputElement>('input')!.click());
  expect(send).toHaveBeenCalledWith("https://core.test/api/core/agents/notes", { revision: "revision-reviewed", offered: true }, "PUT");
});
it("approves the displayed digest with its revision and leaves tools disabled", async () => {
  await render();
  expect(container.querySelector("pre")?.textContent).toBe("Entire reviewed text");
  await act(async () => [...container.querySelectorAll("button")].find(b => b.textContent === "Approve these instructions")!.click());
  expect(send).toHaveBeenCalledWith("https://core.test/api/core/agents/notes", { revision: "revision-reviewed", offered: false, approveSkills: { agent: "new" } }, "PUT");
});
it("keeps confirmed state and reloads after a stale approval", async () => {
  send.mockResolvedValue(Response.json({ code: "agent_policy_changed" }, { status: 409 }));
  await render();
  await act(async () => [...container.querySelectorAll("button")].find(b => b.textContent === "Approve these instructions")!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Review the current state");
  expect(container.querySelector<HTMLInputElement>("input")?.checked).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("does not show login redirect errors on initial load or refresh", async () => {
  vi.mocked(redirectToCoreLoginIfAuthRequired).mockImplementation(() => { throw new AuthRequiredRedirectError(); });
  await render();
  expect(container.querySelector('[role="alert"]')).toBeNull();
  await act(async () => [...container.querySelectorAll("button")].find(b => b.textContent === "Refresh")!.click());
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(redirectToCoreLoginIfAuthRequired).toHaveBeenCalledTimes(2);
});
it("does not show login redirect errors while saving", async () => {
  await render();
  send.mockRejectedValue(new AuthRequiredRedirectError());
  await act(async () => container.querySelector<HTMLInputElement>('input')!.click());
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("assigns a target to one assistant without changing the global offer", async () => {
  vi.mocked(fetch).mockResolvedValue(Response.json({ ...directory, assistants: [{ id: "harness", displayName: "Harness" }] }));
  await render();
  await act(async () => container.querySelector<HTMLInputElement>('input[aria-label="Allow Harness to use Notes MCP"]')!.click());
  expect(send).toHaveBeenCalledWith("https://core.test/api/core/agents/notes", { revision: "revision-reviewed", offered: false, assistantIds: ["harness"] }, "PUT");
});
