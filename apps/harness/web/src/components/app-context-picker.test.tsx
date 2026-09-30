// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppContextPicker, type AppContextPickerHandle } from "./app-context-picker";
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
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.mocked(selectedContextApps).mockResolvedValue([{ id: "media", displayName: "Media Server", available: false }]);
  vi.mocked(listContextApps).mockResolvedValue({ apps: [], nextOffset: null });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.resetAllMocks(); vi.unstubAllGlobals();
});

const openPicker = async () => act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Select app context"]')!.click());
const removeMedia = async () => act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Remove Media Server from context"]')!.click());
const apply = async () => act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === "Apply")!.click());

it("removes context without submitting the surrounding composer and reports pending saves", async () => {
  const onSubmit = vi.fn(event => event.preventDefault());
  const onBusyChange = vi.fn();
  const onChange = vi.fn();
  let resolve!: (session: AssistantSession) => void;
  vi.mocked(setSessionApps).mockReturnValue(new Promise(done => { resolve = done; }));
  await act(async () => root.render(<form onSubmit={onSubmit}>
    <AppContextPicker session={session} busy={false} running onChange={onChange} onBusyChange={onBusyChange} />
  </form>));
  await openPicker();
  expect(document.body.textContent).toContain("Media Server · Unavailable");
  expect(document.body.textContent).toContain("Applies to your next message");
  await removeMedia();
  expect(setSessionApps).not.toHaveBeenCalled();
  await apply();
  expect(onSubmit).not.toHaveBeenCalled();
  expect(setSessionApps).toHaveBeenCalledWith("s", [], 2);
  expect(container.querySelector<HTMLButtonElement>('[aria-label="Select app context"]')!.disabled).toBe(true);
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
  await openPicker(); await removeMedia(); await apply();
  expect(onChange).toHaveBeenCalledWith(updated);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Context changed in another window");
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
  await openPicker(); await removeMedia(); await apply();
  await render(latest);
  expect(first.mock.calls.map(([busy]) => busy)).toEqual([false, true]);
  expect(latest.mock.calls.map(([busy]) => busy)).toEqual([true]);
  await act(async () => root.render(null));
  expect(latest.mock.calls.map(([busy]) => busy)).toEqual([true, false]);
});

it("caps the preview at three icons and shows the remaining count without wrapping names", async () => {
  const ids = Array.from({ length: 16 }, (_, i) => `app-${i}`);
  vi.mocked(selectedContextApps).mockResolvedValue(ids.map(id => ({ id, displayName: `Long application name ${id}`, available: true })));
  await act(async () => root.render(<AppContextPicker session={{ ...session, appIds: ids }} busy={false} running={false} onChange={vi.fn()} />));
  expect(container.querySelectorAll('[data-slot="context-app-preview"]')).toHaveLength(3);
  expect(container.textContent).toContain("+13");
  expect(container.textContent).not.toContain("Long application name");
  await openPicker();
  expect(document.querySelectorAll('[aria-label^="Remove Long application name"]')).toHaveLength(16);
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === "Cancel")!.click());
  expect(setSessionApps).not.toHaveBeenCalled();
});

it("keeps removal as a draft and restores it after cancel, including unavailable apps", async () => {
  await act(async () => root.render(<AppContextPicker session={session} busy={false} running={false} onChange={vi.fn()} />));
  await openPicker(); await removeMedia();
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === "Cancel")!.click());
  await openPicker();
  expect(document.querySelector('[aria-label="Remove Media Server from context"]')).not.toBeNull();
  expect(setSessionApps).not.toHaveBeenCalled();
});

it("opens an empty compact picker from the shared plus and restores focus to that opener", async () => {
  const ref = createRef<AppContextPickerHandle>();
  const opener = createRef<HTMLButtonElement>();
  await act(async () => root.render(<><button ref={opener} onClick={() => ref.current?.open()}>Add app context</button>
    <AppContextPicker ref={ref} opener={opener} compact session={{ ...session, appIds: [] }} busy={false} running={false} onChange={vi.fn()} /></>));
  expect(container.querySelector('[aria-label="Select app context"]')?.className).toContain("hidden");
  await act(async () => opener.current!.click());
  expect(document.querySelector('[aria-label="Select apps for this session"]')).not.toBeNull();
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === "Cancel")!.click());
  expect(document.activeElement).toBe(opener.current);
  expect(setSessionApps).not.toHaveBeenCalled();
});
