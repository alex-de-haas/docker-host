// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PromptTemplatesSettings } from "./prompt-templates-settings";
import { GatewaySettings } from "./gateway-settings";
import { ApiError, loadSettings } from "@/lib/api";
import { loadPromptTemplates, savePromptTemplates, type PromptTemplateCollection } from "@/lib/prompt-templates-api";

vi.mock("@/lib/prompt-templates-api", async original => ({ ...await original<typeof import("@/lib/prompt-templates-api")>(), loadPromptTemplates: vi.fn(), savePromptTemplates: vi.fn() }));
vi.mock("@/lib/api", async original => ({ ...await original<typeof import("@/lib/api")>(), loadSettings: vi.fn() }));

let root: Root, container: HTMLDivElement;
const template = { id: "c50a33ce-ebc1-4b31-ad34-c9c184940ab3", name: "Pull request", shortcut: "pr", text: "Original prompt" };
const other = { id: "374e7ef2-7f0b-4a8a-a2db-ce1917f87202", name: "Review", shortcut: "review", text: "Review carefully" };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(loadPromptTemplates).mockResolvedValue({ revision: 4, templates: [template] });
  vi.mocked(savePromptTemplates).mockImplementation(async input => ({ revision: input.revision + 1, templates: input.templates }));
  vi.mocked(loadSettings).mockRejectedValue(new Error("Shared settings unavailable"));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.resetAllMocks(); vi.unstubAllGlobals(); });
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === name)!;
const click = (name: string) => act(async () => button(name).click());
const input = (id: string) => document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement;
async function change(id: string, value: string) {
  const node = input(id);
  await act(async () => {
    const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const render = () => act(async () => root.render(<PromptTemplatesSettings />));

it("shows loading and empty states, then creates a personal template verbatim", async () => {
  let finish!: (value: PromptTemplateCollection) => void;
  vi.mocked(loadPromptTemplates).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  await render(); expect(container.textContent).toContain("Loading prompt templates");
  expect(button("Create template").disabled).toBe(true);
  await act(async () => finish({ revision: 0, templates: [] }));
  expect(container.textContent).toContain("No prompt templates yet");
  await click("Create template");
  await change("template-name", "  Pull request  "); await change("template-shortcut", "PR");
  const text = "  Подготовь PR\n@literal /text\n "; await change("template-text", text);
  await click("Save template");
  expect(savePromptTemplates).toHaveBeenCalledWith({ revision: 0, requestId: expect.any(String), templates: [{ id: expect.any(String), name: "Pull request", shortcut: "pr", text }] });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(container.textContent).toContain("!pr"); expect(container.textContent).toContain("Prompt template saved");
});

it("shows inline duplicate and required errors without losing the draft or making a request", async () => {
  vi.mocked(loadPromptTemplates).mockResolvedValue({ revision: 4, templates: [template, other] });
  await render(); await click("Edit Review");
  await change("template-shortcut", "PR"); await change("template-name", " "); await change("template-text", "\n ");
  await click("Save template");
  expect(input("template-shortcut").getAttribute("aria-invalid")).toBe("true");
  expect(document.body.textContent).toContain("This shortcut is already used");
  expect(document.body.textContent).toContain("Enter a title"); expect(document.body.textContent).toContain("Enter prompt text");
  expect(input("template-shortcut").value).toBe("PR"); expect(savePromptTemplates).not.toHaveBeenCalled();
});

it("keeps an unsaved edit on a known failure and allows correcting it", async () => {
  vi.mocked(savePromptTemplates).mockRejectedValueOnce(new ApiError(400, "invalid", "Could not accept template"));
  await render(); await click("Edit Pull request"); await change("template-text", "Unsaved prompt"); await click("Save template");
  expect(input("template-text").value).toBe("Unsaved prompt"); expect(input("template-text").disabled).toBe(false);
  expect(document.body.textContent).toContain("Could not accept template");
  await change("template-name", "Updated title"); await click("Save template");
  expect(savePromptTemplates).toHaveBeenLastCalledWith(expect.objectContaining({ templates: [expect.objectContaining({ name: "Updated title", text: "Unsaved prompt" })] }));
});

it("reloads a conflict explicitly while retaining the edit and concurrent templates", async () => {
  vi.mocked(savePromptTemplates).mockRejectedValueOnce(new ApiError(409, "revision_conflict", "Templates changed"));
  await render(); await click("Edit Pull request"); await change("template-text", "Local draft"); await click("Save template");
  expect(button("Save template").disabled).toBe(true); expect(loadPromptTemplates).toHaveBeenCalledTimes(1);
  const original = vi.mocked(savePromptTemplates).mock.calls[0]![0];
  vi.mocked(loadPromptTemplates).mockResolvedValue({ revision: 8, templates: [{ ...template, text: "Concurrent prompt" }, other] });
  await click("Reload saved templates");
  expect(input("template-text").value).toBe("Local draft"); expect(button("Save template").disabled).toBe(false);
  await click("Save template");
  const saved = vi.mocked(savePromptTemplates).mock.calls[1]![0];
  expect(saved.revision).toBe(8); expect(saved.requestId).not.toBe(original.requestId);
  expect(saved.templates).toEqual([{ ...template, text: "Local draft" }, other]);
});

it("keeps and replays the identical request after an uncertain save before allowing changes", async () => {
  vi.mocked(savePromptTemplates).mockRejectedValueOnce(new Error("Connection lost"));
  await render(); await click("Edit Pull request"); await change("template-text", "Preserved draft"); await click("Save template");
  expect(document.body.textContent).toContain("The save result is unknown");
  expect(input("template-text").value).toBe("Preserved draft"); expect(input("template-text").disabled).toBe(true);
  expect(button("Refresh").disabled).toBe(true); expect(button("Cancel").disabled).toBe(true);
  const original = vi.mocked(savePromptTemplates).mock.calls[0]![0];
  await click("Retry save");
  expect(vi.mocked(savePromptTemplates).mock.calls[1]![0]).toBe(original);
  expect(container.textContent).toContain("Prompt template saved");
  expect(button("Create template").disabled).toBe(false);
});

it("confirms deletion and keeps other templates intact", async () => {
  vi.mocked(loadPromptTemplates).mockResolvedValue({ revision: 4, templates: [template, other] });
  await render(); await click("Delete Pull request"); expect(savePromptTemplates).not.toHaveBeenCalled();
  await click("Delete template");
  expect(savePromptTemplates).toHaveBeenCalledWith({ revision: 4, requestId: expect.any(String), templates: [other] });
  expect(container.textContent).toContain("Review"); expect(container.textContent).not.toContain("Pull request");
});

it("offers refresh after a loading error and returns focus after cancelling an edit", async () => {
  vi.mocked(loadPromptTemplates).mockRejectedValueOnce(new Error("Storage unavailable"));
  await render(); expect(container.textContent).toContain("Storage unavailable");
  expect(button("Create template").disabled).toBe(true); await click("Refresh");
  const opener = button("Create template");
  await act(async () => { opener.focus(); opener.click(); }); await click("Cancel");
  await vi.waitFor(() => expect(document.activeElement).toBe(opener));
});

it("opens personal settings without loading shared Harness settings", async () => {
  await act(async () => root.render(<GatewaySettings section="templates" />));
  expect(loadPromptTemplates).toHaveBeenCalledTimes(1); expect(loadSettings).not.toHaveBeenCalled();
  expect(container.textContent).toContain("!pr"); expect(button("Create template").disabled).toBe(false);
});
