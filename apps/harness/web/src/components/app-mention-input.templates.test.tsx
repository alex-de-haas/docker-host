// @vitest-environment jsdom
import { act, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppMentionInput, type AppMentionInputHandle } from "./app-mention-input";
import { loadPromptTemplates } from "@/lib/prompt-templates-api";
import { readMentionDraft, writeMentionDraft } from "@/lib/app-mentions";
import { listContextApps, setSessionApps, type AssistantSession } from "@/lib/assistant-api";
vi.mock("@/lib/prompt-templates-api", () => ({ loadPromptTemplates: vi.fn() }));
vi.mock("@/lib/assistant-api", async original => ({ ...await original<typeof import("@/lib/assistant-api")>(), listContextApps: vi.fn(), setSessionApps: vi.fn() }));
const template = { id: "pr", name: "Prepare pull request", shortcut: "pr", text: "Проверь PR 🐾\n@literal /pr" };
const session: AssistantSession = { id: "templates-chat", title: null, status: "idle", createdAt: "", appIds: ["app"] };
const sent = vi.fn();
let root: Root, container: HTMLDivElement;
let change!: (text: string) => void;
function Harness({ seed = "", disabled = false }: { seed?: string; disabled?: boolean }) {
  const [value, setValue] = useState(seed);
  useEffect(() => { change = setValue; }, []);
  const ref = useRef<AppMentionInputHandle>(null);
  return <><button onClick={() => ref.current?.openTemplates()}>Templates</button><span>attachment.png</span>
    <AppMentionInput ref={ref} session={session} value={value} onChange={setValue} inputRef={useRef(null)} contextBusy={false} disabled={disabled}
      aria-label="Message" onContextChange={vi.fn()} onBusyChange={vi.fn()} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) sent(value); }} /></>;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 0; });
  vi.mocked(loadPromptTemplates).mockResolvedValue({ revision: 1, templates: [template] });
  localStorage.clear();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.resetAllMocks(); vi.unstubAllGlobals(); });
const input = () => container.querySelector<HTMLTextAreaElement>("textarea")!;
const render = (seed = "") => act(async () => root.render(<Harness seed={seed} />));
const type = (text: string, caret = text.length) => act(async () => {
  input().focus();
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input(), text);
  input().setSelectionRange(caret, caret); input().dispatchEvent(new Event("input", { bubbles: true }));
});
const key = (key: string, other = {}) => act(async () => { input().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...other })); });
const menu = () => act(async () => container.querySelector<HTMLButtonElement>("button")!.click());

it("replaces only the typed alias with literal multiline text, preserving mentions and surrounding draft", async () => {
  const seed = "@App !pr tail";
  writeMentionDraft(session.id, { text: seed, mentions: [{ id: "app", label: "@App", start: 0, end: 4 }] });
  await render(seed); await type(seed, 8); await key("Tab");
  expect(input().value).toBe(`@App ${template.text} tail`);
  expect(input().selectionStart).toBe(5 + template.text.length);
  expect(readMentionDraft(session.id, input().value).mentions).toEqual([{ id: "app", label: "@App", start: 0, end: 4 }]);
  expect(setSessionApps).not.toHaveBeenCalled(); expect(listContextApps).not.toHaveBeenCalled(); expect(sent).not.toHaveBeenCalled();
  expect(container.textContent).toContain("attachment.png");
});

it("inserts with Enter and preserves undo/redo plus original mention identities", async () => {
  await render(); await type("!pr"); await key("Enter");
  expect(input().value).toBe(template.text); expect(sent).not.toHaveBeenCalled();
  await key("z", { ctrlKey: true }); expect(input().value).toBe("!pr");
  await key("z", { ctrlKey: true, shiftKey: true }); expect(input().value).toBe(template.text);
  expect(readMentionDraft(session.id, input().value).mentions).toEqual([]);
});

it("opens from the menu at the saved selection and searches by title", async () => {
  await render("Before replace after"); input().focus(); input().setSelectionRange(7, 14);
  await act(async () => input().dispatchEvent(new Event("select", { bubbles: true })));
  await menu();
  const search = document.querySelector<HTMLInputElement>('input[aria-label="Search prompt templates"]')!;
  expect(search).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "pull request");
    search.dispatchEvent(new Event("input", { bubbles: true }));
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
  expect(input().value).toBe(`Before ${template.text} after`); expect(document.activeElement).toBe(input()); expect(sent).not.toHaveBeenCalled();
});

it("never sends from an empty, loading or failed shortcut picker and Escape preserves literal text", async () => {
  let resolve!: (value: Awaited<ReturnType<typeof loadPromptTemplates>>) => void;
  vi.mocked(loadPromptTemplates).mockReturnValueOnce(new Promise(done => { resolve = done; }));
  await render(); await type("!unknown"); await key("Enter"); expect(sent).not.toHaveBeenCalled();
  await act(async () => resolve({ revision: 0, templates: [] }));
  await key("Enter"); expect(sent).not.toHaveBeenCalled(); expect(input().value).toBe("!unknown");
  await key("Escape"); await key("Enter"); expect(sent).toHaveBeenLastCalledWith("!unknown");
  vi.mocked(loadPromptTemplates).mockRejectedValueOnce(new Error("Templates unavailable"));
  await type("!pr"); expect(document.body.textContent).toContain("Templates unavailable");
  await key("Enter"); expect(sent).toHaveBeenCalledTimes(1);
  await act(async () => Array.from(document.querySelectorAll("button")).find(button => button.textContent === "Retry templates")!.click());
  await key("Enter"); expect(input().value).toBe(template.text);
});

it("keeps Shift+Enter and IME independent of template selection", async () => {
  await render(); await type("!pr");
  await key("Enter", { isComposing: true }); await key("Enter", { shiftKey: true });
  await key("Enter", { ctrlKey: true }); await key("Enter", { metaKey: true }); await key("Enter", { altKey: true });
  expect(input().value).toBe("!pr"); expect(sent).not.toHaveBeenCalled();
  await key("Enter"); expect(input().value).toBe(template.text);
});

it("leaves literal trailing app syntax inert and keeps picker links keyboard-operable", async () => {
  vi.mocked(loadPromptTemplates).mockResolvedValue({ revision: 1, templates: [{ ...template, text: "Check @media" }] });
  await render(); await type("!pr");
  const link = document.querySelector<HTMLAnchorElement>('a[href="/settings/templates"]')!;
  let prevented = true;
  await act(async () => {
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    link.dispatchEvent(event); prevented = event.defaultPrevented;
  });
  expect(prevented).toBe(false); expect(input().value).toBe("!pr");
  await key("Enter"); expect(input().value).toBe("Check @media");
  expect(listContextApps).not.toHaveBeenCalled();
  await key("Enter"); expect(sent).toHaveBeenLastCalledWith("Check @media"); expect(setSessionApps).not.toHaveBeenCalled();
});

it("ignores old responses after reopening and discards an obsolete menu selection after external edits", async () => {
  let resolve!: (value: Awaited<ReturnType<typeof loadPromptTemplates>>) => void;
  vi.mocked(loadPromptTemplates).mockReturnValueOnce(new Promise(done => { resolve = done; }));
  await render("Draft"); await menu();
  await act(async () => change("New draft")); expect(document.querySelector('[role="option"]')).toBeNull();
  await menu();
  await act(async () => resolve({ revision: 0, templates: [{ ...template, name: "Stale template" }] }));
  expect(document.querySelector('[role="option"]')?.textContent).toContain(template.name);
  expect(document.body.textContent).not.toContain("Stale template");
});

it("uses arrow keys to select another template without sending", async () => {
  vi.mocked(loadPromptTemplates).mockResolvedValue({ revision: 1, templates: [template, { ...template, id: "review", shortcut: "review", text: "Second template" }] });
  await render(); await type("!"); await key("ArrowDown"); await key("Enter");
  expect(input().value).toBe("Second template"); expect(sent).not.toHaveBeenCalled();
});
