// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SessionExecutionRecovery } from "./session-execution-recovery";

it("dismisses one attempt, reveals a subsequent attempt and clears a settled notice", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const div = document.createElement("div"), root = createRoot(div);
  const render = (run: string, pending: boolean) => act(async () => root.render(<SessionExecutionRecovery
    sessionId="chat" refreshKey={run} stopIssue={pending ? { message: "The provider is reconnecting." } : undefined} />));
  try {
    await render("first", true);
    expect(div.querySelector('[role="status"]')?.textContent).toContain("Waiting for stop confirmation");
    await act(async () => div.querySelector("button")!.click());
    expect(div.textContent).toBe("");
    await render("second", true);
    expect(div.querySelector("button")?.textContent).toBe("Dismiss");
    await render("second", false);
    expect(div.textContent).toBe("");
  } finally { await act(async () => root.unmount()); sessionStorage.clear(); vi.unstubAllGlobals(); }
});
