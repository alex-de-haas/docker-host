// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppContextPicker } from "./app-context-picker";
import { AssistantApiError, getSession, listContextApps, selectedContextApps, setSessionApps, type AssistantSession } from "../lib/assistant-api";

vi.mock("../lib/assistant-api", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/assistant-api")>(),
  getSession: vi.fn(), listContextApps: vi.fn(), selectedContextApps: vi.fn(), setSessionApps: vi.fn(),
}));

let container: HTMLDivElement;
let root: Root;
const session: AssistantSession = { id: "s", title: null, status: "idle", createdAt: "", appIds: ["media"], appContextRevision: 2 };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(selectedContextApps).mockResolvedValue([{ id: "media", displayName: "Media Server", available: false }]);
  vi.mocked(listContextApps).mockResolvedValue({ apps: [], nextOffset: null });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.resetAllMocks(); vi.unstubAllGlobals();
});

it("removes context without submitting the surrounding composer and reports pending saves", async () => {
  const onSubmit = vi.fn(event => event.preventDefault());
  const onBusyChange = vi.fn();
  const onChange = vi.fn();
  let resolve!: (session: AssistantSession) => void;
  vi.mocked(setSessionApps).mockReturnValue(new Promise(done => { resolve = done; }));
  await act(async () => root.render(<form onSubmit={onSubmit}>
    <AppContextPicker session={session} busy={false} running onChange={onChange} onBusyChange={onBusyChange} />
  </form>));
  expect(container.textContent).toContain("Media Server · Unavailable");
  expect(container.textContent).toContain("Applies to your next message");
  const remove = container.querySelector<HTMLButtonElement>('[aria-label="Remove Media Server from context"]')!;
  await act(async () => remove.click());
  expect(onSubmit).not.toHaveBeenCalled();
  expect(setSessionApps).toHaveBeenCalledWith("s", [], 2);
  expect(remove.disabled).toBe(true);
  expect(onBusyChange).toHaveBeenLastCalledWith(true);
  expect(onBusyChange.mock.calls.map(([busy]) => busy)).toEqual([false, true]);
  const updated = { ...session, appIds: [], appContextRevision: 3 };
  await act(async () => resolve(updated));
  expect(onChange).toHaveBeenCalledWith(updated);
  expect(onBusyChange).toHaveBeenLastCalledWith(false);
});

it("refreshes a conflicting context revision and leaves failure feedback visible", async () => {
  const updated = { ...session, appIds: ["media", "other"], appContextRevision: 3 };
  vi.mocked(setSessionApps).mockRejectedValue(new AssistantApiError("app_context_conflict", "Context changed in another window"));
  vi.mocked(getSession).mockResolvedValue(updated);
  const onChange = vi.fn();
  await act(async () => root.render(<AppContextPicker session={session} busy={false} running={false} onChange={onChange} />));
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Remove Media Server from context"]')!.click());
  expect(onChange).toHaveBeenCalledWith(updated);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Context changed in another window");
  expect(container.querySelector<HTMLButtonElement>('[aria-label="Select app context"]')!.disabled).toBe(false);
});

it("keeps a pending save busy across listener changes and clears the latest listener on unmount", async () => {
  vi.mocked(setSessionApps).mockReturnValue(new Promise(() => {}));
  const first = vi.fn();
  const latest = vi.fn();
  const render = async (onBusyChange: (busy: boolean) => void) => act(async () => root.render(
    <AppContextPicker session={session} busy={false} running={false} onChange={vi.fn()} onBusyChange={onBusyChange} />,
  ));
  await render(first);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Remove Media Server from context"]')!.click());
  await render(latest);
  expect(first.mock.calls.map(([busy]) => busy)).toEqual([false, true]);
  expect(latest.mock.calls.map(([busy]) => busy)).toEqual([true]);
  await act(async () => root.render(null));
  expect(latest.mock.calls.map(([busy]) => busy)).toEqual([true, false]);
});
