// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { TranslationProviders } from "../web/src/components/translation-providers.js";
import type { AgentConnection } from "../web/src/components/agent-providers.js";
const call = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ call }));
afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); });
it("retains unavailable selections and saves the selected variant without silently choosing an account", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const configuration = { variants: [{ key: "codex", connectionId: "removed", model: "custom-codex-model", suggestedModels: [], ready: false, reason: "Select it again." },
    { key: "claude", connectionId: null, model: "haiku", suggestedModels: [{ id: "haiku", label: "Haiku" }], ready: false, reason: "Choose a connection." }] };
  call.mockImplementation(async () => Response.json(configuration));
  const container = document.createElement("div"), root = createRoot(container);
  document.body.append(container);
  try {
    await act(async () => root.render(<TranslationProviders connections={[] as AgentConnection[]} />));
    expect(container.textContent).toContain("Unavailable connection");
    expect(container.textContent).toContain("Disabled");
    const save = [...container.querySelectorAll("button")].find(button => button.textContent === "Save Codex translation")!;
    await act(async () => save.click());
    expect(container.querySelector<HTMLInputElement>("#translation-codex-custom-model")?.value).toBe("custom-codex-model");
    expect(call).toHaveBeenLastCalledWith("/settings/translation/codex", { method: "PUT", body: JSON.stringify({ connectionId: "removed", model: "custom-codex-model" }) });
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Codex translation settings saved");
    const claudeSave = [...container.querySelectorAll("button")].find(button => button.textContent === "Save Claude translation")!;
    await act(async () => claudeSave.click());
    expect(call).toHaveBeenLastCalledWith("/settings/translation/claude", { method: "PUT", body: JSON.stringify({ connectionId: null, model: "haiku" }) });
  } finally { await act(async () => root.unmount()); container.remove(); }
});
