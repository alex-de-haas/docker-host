// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { SessionProfile } from "./session-profile";
import * as api from "@/lib/profiles-api";
import type { AssistantSession } from "@/lib/assistant-api";
vi.mock("@/lib/profiles-api", () => ({ listProfiles: vi.fn(), selectSessionProfile: vi.fn() }));
let root: Root, container: HTMLDivElement;
const profile = { id: "planner", revision: 2, name: "Planner", description: "Plans", instructions: "Plan", connectionId: null, model: null, reasoningEffort: null, skillIds: [] };
const session: AssistantSession = { id: "chat", title: null, createdAt: "", status: "idle", agentProfile: null, profileLocked: false, selectionRevision: 3 };
const changed = vi.fn(), saving = vi.fn();
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.mocked(api.listProfiles).mockResolvedValue({ revision: 1, defaultId: "planner", profiles: [profile] });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.resetAllMocks(); vi.unstubAllGlobals(); });
it("selects the reviewed profile revision and holds the send interlock until saved", async () => {
  vi.mocked(api.selectSessionProfile).mockResolvedValue({ ...session, agentProfile: profile, selectionRevision: 4 });
  await act(async () => root.render(<SessionProfile session={session} busy={false} onChange={changed} onSavingChange={saving} />));
  await act(async () => container.querySelector("button")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  await act(async () => [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(e => e.textContent?.includes("Planner"))!.click());
  expect(api.selectSessionProfile).toHaveBeenCalledExactlyOnceWith("chat", "planner", 2, 3); expect(saving.mock.calls).toEqual([[true], [false]]); expect(changed).toHaveBeenCalledOnce();
});
it("shows the retained profile after deletion and disables changes once started", async () => {
  await act(async () => root.render(<SessionProfile session={{ ...session, agentProfile: profile, profileLocked: true }} busy={false} onChange={changed} onSavingChange={saving} />));
  expect(container.textContent).toContain("Planner"); expect(container.querySelector("button")!.disabled).toBe(true); expect(api.listProfiles).not.toHaveBeenCalled();
});
