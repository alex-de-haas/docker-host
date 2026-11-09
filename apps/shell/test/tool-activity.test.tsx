import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UiPanel, ToolActivity } from "@hosty-sdk/app/ui/types";
import { ToolActivityProvider, useToolActivity, ToolActivityMark, ToolsActivityBadge, activitySummary } from "../src/app/shell/chrome/tool-activity";
import type { CoreEventSubscription } from "../src/app/shell/events/core-event-stream";

let subscription: CoreEventSubscription;
const detach = vi.fn();
vi.mock("../src/app/shell/events/core-event-stream", () => ({
  CoreEventNames: { toolActivityChanged: "tool.activity.changed" },
  subscribeToCoreEvents: (_origin: string, value: CoreEventSubscription) => { subscription = value; void value.onSync(); return detach; },
}));
vi.mock("@hosty-sdk/app/browser-auth", () => ({ appFetch: (...args: Parameters<typeof fetch>) => fetch(...args) }));
const panel: UiPanel = { panel: { appId: "harness", installationId: "one", panelId: "assistant" }, label: "Assistant",
  appName: "Harness", endpoint: "web", route: "/assistant", icon: null, origin: "https://harness.test", available: true,
  canStart: false, state: "running", framePolicy: { microphone: false, popupEscape: false } };
const value = (state: ToolActivity["state"], count: number | null = null): ToolActivity => ({
  panel: panel.panel, state, count, label: null, reportedAt: "2026-10-25T12:00:00Z", expiresAt: null,
});
function View() {
  const activity = useToolActivity().read(panel);
  return <><ToolActivityMark activity={activity} /><ToolsActivityBadge values={[activity]} /><input aria-label="Draft" defaultValue="Kept" /></>;
}
let container: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ activities: [value("needs-you", 7)] })));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container); detach.mockClear();
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const render = (userId = "one") => act(async () => root.render(<ToolActivityProvider coreOrigin="https://core.test" userId={userId}><View /></ToolActivityProvider>));
it("shows unopened tools and counts tools, not provider decisions; hint refresh retains drafts", async () => {
  await render();
  expect(container.textContent).toContain("Needs you · 7");
  expect(container.querySelector('[aria-label="1 tools need you"]')).not.toBeNull();
  const draft = container.querySelector("input")!; draft.value = "Still here";
  vi.mocked(fetch).mockResolvedValue(Response.json({ activities: [value("working")] }));
  await act(async () => subscription.onSync());
  expect(container.textContent).toContain("Working");
  expect(container.querySelector("input")).toBe(draft);
  expect(draft.value).toBe("Still here");
  expect(container.querySelector('[aria-label="1 tools need you"]')).toBeNull();
});
it("masks stale activity on lost Core connection and resyncs on reconnect", async () => {
  await render();
  await act(async () => subscription.onStreamState?.("error"));
  expect(container.textContent).toContain("No connection");
  expect(container.textContent).toContain("Last report");
  expect(container.textContent).not.toContain("Needs you");
  vi.mocked(fetch).mockResolvedValue(Response.json({ activities: [value("failed")] }));
  await act(async () => subscription.onSync());
  expect(container.textContent).toContain("Failed");
});
it("clears the old actor immediately and ignores their delayed response", async () => {
  let finish!: (r: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await render();
  vi.mocked(fetch).mockResolvedValue(Response.json({ activities: [] }));
  await render("two");
  await act(async () => { finish(Response.json({ activities: [value("failed")] })); });
  expect(container.textContent).toContain("Idle");
  expect(container.textContent).not.toContain("Failed");
  expect(detach).toHaveBeenCalledOnce();
});
it("prioritizes failure, decisions and then work", () => {
  expect(activitySummary([value("working"), value("needs-you", 9), value("failed", 5)])).toEqual({ count: 2, state: "failed" });
  expect(activitySummary([value("working"), value("needs-you")])).toEqual({ count: 1, state: "needs-you" });
  expect(activitySummary([value("working"), value("no-connection")])).toEqual({ count: 0, state: "working" });
});

it("suspends pending retries when hidden and resynchronizes on return", async () => {
  vi.useFakeTimers();
  vi.mocked(fetch).mockRejectedValue(new TypeError("offline"));
  await render();
  const requests = vi.mocked(fetch).mock.calls.length;
  await act(async () => subscription.onStreamState?.("inactive"));
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(fetch).toHaveBeenCalledTimes(requests);
  vi.mocked(fetch).mockResolvedValue(Response.json({ activities: [value("needs-you", 1)] }));
  await act(async () => { subscription.onStreamState?.("stream"); await subscription.onSync(); });
  expect(container.textContent).toContain("Needs you · 1");
});
