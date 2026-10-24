// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { RetainedWorkspacePane } from "./retained-workspace-pane";
it("retains workspace form state through desktop/sheet transitions and returns keyboard focus", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let narrow = false; const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", () => ({ get matches() { return narrow; }, addEventListener(_type: string, listener: () => void) { listeners.add(listener); }, removeEventListener(_type: string, listener: () => void) { listeners.delete(listener); } }));
  const rects = vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{ width: 10, height: 10 }] as unknown as DOMRectList);
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  function Harness() {
    const [open, setOpen] = useState(false);
    return <><button onClick={() => setOpen(true)}>Workspace</button><RetainedWorkspacePane open={open} visible reviewing={false} onClose={() => setOpen(false)}><textarea aria-label="Workspace draft" defaultValue="original" /></RetainedWorkspacePane></>;
  }
  try {
    await act(async () => root.render(<Harness />));
    const field = container.querySelector("textarea")!; field.value = "unsaved workspace text";
    await act(async () => { narrow = true; listeners.forEach(listener => listener()); });
    const opener = container.querySelector("button")!; opener.focus(); await act(async () => opener.click());
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement?.textContent).toBe("Back to conversation");
    field.focus(); await act(async () => field.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })));
    expect(document.activeElement?.textContent).toBe("Back to conversation");
    await act(async () => field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(container.querySelector('[role="dialog"]')).toBeNull(); expect(document.activeElement).toBe(opener);
    await act(async () => { narrow = false; listeners.forEach(listener => listener()); });
    expect(container.querySelector("textarea")).toBe(field); expect(field.value).toBe("unsaved workspace text");
  } finally { await act(async () => root.unmount()); container.remove(); rects.mockRestore(); vi.unstubAllGlobals(); }
});
