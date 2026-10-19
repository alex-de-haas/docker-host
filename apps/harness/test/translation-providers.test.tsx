// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TranslationProviders } from "../web/src/components/translation-providers.js";
import type { AgentConnection } from "../web/src/components/agent-providers.js";

const call = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ call }));
type Variant = { key: "codex" | "claude"; connectionId: string | null; model: string | null; suggestedModels: { id: string; label: string }[]; ready: boolean; reason?: string };
let variants: Variant[];
let connections: AgentConnection[];
let root: Root;
let container: HTMLDivElement;
const connection = (id: string, kind: "codex" | "claude" = "codex"): AgentConnection => ({ id, name: id, kind, auth: "chatgpt", available: true, revision: 1 });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  variants = [
    { key: "codex", connectionId: null, model: "gpt-6-luna", suggestedModels: [{ id: "gpt-6-luna", label: "GPT-6 Luna" }], ready: false },
    { key: "claude", connectionId: null, model: "haiku", suggestedModels: [{ id: "haiku", label: "Haiku" }], ready: false },
  ];
  connections = [connection("Codex"), connection("Claude", "claude")];
  call.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/connections") return Response.json({ connections });
    if (init?.method === "PUT") {
      const patch = JSON.parse(String(init.body)) as { connectionId: string | null; model: string | null };
      const variant = variants.find(item => path.endsWith(item.key))!;
      Object.assign(variant, patch, { ready: patch.connectionId !== null });
    }
    return Response.json({ variants });
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
});
const render = () => act(async () => root.render(<TranslationProviders />));
const control = (name: string) => container.querySelector<HTMLButtonElement>(`[aria-label="${name}"]`)!;
const writes = () => call.mock.calls.filter(([, init]) => init?.method === "PUT");
async function choose(name: string, option: string) {
  await act(async () => control(name).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  const item = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(element => element.textContent === option)!;
  expect(item, `Option ${option}`).toBeTruthy();
  await act(async () => item.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
}
const toggle = (label = "Codex") => act(async () => control(`Enable ${label} translation`).click());

it("keeps models visible while disabled and saves switch and preset changes immediately", async () => {
  await render();
  expect(container.querySelectorAll('[role="switch"]')).toHaveLength(2);
  expect(container.querySelectorAll('[role="combobox"]')).toHaveLength(2);
  expect(control("Codex model").textContent).toBe("GPT-6 Luna");
  expect(control("Codex model").disabled).toBe(false);
  expect(control("Enable Codex translation").getAttribute("aria-checked")).toBe("false");
  expect(writes()).toHaveLength(0);
  await toggle();
  expect(writes().at(-1)).toEqual(["/settings/translation/codex", { method: "PUT", body: JSON.stringify({ connectionId: "Codex", model: "gpt-6-luna" }) }]);
  expect(control("Enable Codex translation").getAttribute("aria-checked")).toBe("true");
  await toggle();
  await choose("Codex model", "Agent default");
  expect(writes().at(-1)).toEqual(["/settings/translation/codex", { method: "PUT", body: JSON.stringify({ connectionId: null, model: null }) }]);
  await toggle();
  expect(variants[0]).toMatchObject({ connectionId: "Codex", model: null });
  expect(variants[1]).toMatchObject({ connectionId: null, model: "haiku" });
});

it("requires an explicit choice for multiple accounts and remembers it while toggling off", async () => {
  connections.push(connection("Dedicated Codex"));
  await render();
  expect(control("Enable Codex translation").disabled).toBe(true);
  await choose("Codex connection", "Dedicated Codex");
  expect(writes()).toHaveLength(0);
  await toggle();
  expect(variants[0].connectionId).toBe("Dedicated Codex");
  await toggle();
  await choose("Codex model", "Agent default");
  await toggle();
  expect(variants[0]).toMatchObject({ connectionId: "Dedicated Codex", model: null });
});

it("keeps a removed account visible without selecting the remaining account", async () => {
  variants[0].connectionId = "removed";
  await render();
  expect(control("Codex connection").textContent).toContain("Unavailable connection");
  expect(control("Codex model").disabled).toBe(true);
  expect(writes()).toHaveLength(0);
  await toggle();
  expect(control("Enable Codex translation").disabled).toBe(true);
  await choose("Codex connection", "Codex");
  await toggle();
  expect(variants[0].connectionId).toBe("Codex");
});

it("requires explicit reconnection for a changed account instead of reauthorizing through a model change", async () => {
  variants[0].connectionId = "Codex";
  variants[0].reason = "The selected account changed.";
  await render();
  expect(control("Codex model").disabled).toBe(true);
  expect(container.textContent).toContain("Turn translation off and on to reconnect.");
  expect(writes()).toHaveLength(0);
  await toggle();
  await toggle();
  expect(control("Codex model").disabled).toBe(false);
  expect(variants[0].ready).toBe(true);
});

it("keeps the confirmed switch and model after failures and disables controls during saving", async () => {
  await render();
  let rejectSave!: (error: Error) => void;
  call.mockImplementationOnce(() => new Promise((_, reject) => { rejectSave = reject; }));
  await toggle();
  expect(control("Enable Codex translation").disabled).toBe(true);
  expect(control("Codex model").disabled).toBe(true);
  await act(async () => rejectSave(new Error("Account is busy.")));
  expect(control("Enable Codex translation").getAttribute("aria-checked")).toBe("false");
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Account is busy.");
  call.mockRejectedValueOnce(new Error("Could not save model."));
  await choose("Codex model", "Agent default");
  expect(control("Codex model").textContent).toBe("GPT-6 Luna");
  expect(control("Codex model").disabled).toBe(false);
});

it("keeps custom models, validates the dialog, and saves without enabling translation", async () => {
  variants[0].model = "custom";
  await render();
  expect(control("Codex model").textContent).toBe("custom");
  await choose("Codex model", "Custom model ID…");
  const input = document.querySelector<HTMLInputElement>("#translation-codex-custom-model")!;
  const button = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(element => element.textContent === "Save model")!;
  async function type(value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  expect(input.value).toBe("custom");
  await type("bad model");
  expect(button.disabled).toBe(true);
  await type("model-exact-1.2");
  await act(async () => button.click());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(control("Codex model").textContent).toBe("model-exact-1.2");
  expect(variants[0]).toMatchObject({ connectionId: null, model: "model-exact-1.2" });
});

it("leaves model selection usable when no connected account can be enabled", async () => {
  connections = [];
  await render();
  expect(control("Enable Codex translation").disabled).toBe(true);
  expect(control("Enable Claude translation").disabled).toBe(true);
  expect(container.textContent).toContain("Add a Codex connection in Agent providers.");
  await choose("Claude model", "Agent default");
  expect(variants[1]).toMatchObject({ connectionId: null, model: null });
});

it("reports a connection-directory load failure without presenting actionable settings", async () => {
  call.mockRejectedValueOnce(new Error("Offline"));
  await render();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not load translation settings");
  expect(container.querySelector('[role="switch"]')).toBeNull();
  expect(writes()).toHaveLength(0);
});
