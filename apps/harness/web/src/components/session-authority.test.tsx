// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SessionAuthority } from "./session-authority";
import { appFetch } from "@hosty-sdk/app/browser-auth";
vi.mock("@hosty-sdk/app/browser-auth", () => ({ appFetch: vi.fn(), APP_ACTIVITY_RENEWED: "hosty:app-activity-renewed" }));
it("opens the Core session review on a click and refreshes authority without replacing the draft", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const node = document.createElement("div"); document.body.append(node); const root = createRoot(node);
  const reviewUrl = "http://core.localhost/activity/assistants/harness/session-one";
  vi.mocked(appFetch).mockImplementation(async () => Response.json({ active: false, activeUntil: null, reviewUrl }));
  const popup = vi.spyOn(window, "open").mockReturnValue(null);
  try {
    await act(async () => root.render(<><textarea defaultValue="Unsaved message"/><SessionAuthority sessionId="session-one"/></>));
    const draft = node.querySelector("textarea");
    expect(popup).not.toHaveBeenCalled(); expect(node.textContent).toContain("Allow tools in Core");
    vi.mocked(appFetch).mockImplementation(async () => Response.json({ active: true, activeUntil: new Date(Date.now()+3600_000).toISOString(), reviewUrl }));
    await act(async () => node.querySelector("button")!.click());
    expect(popup).toHaveBeenCalledWith(reviewUrl, "_blank", "noopener,noreferrer");
    expect(appFetch).toHaveBeenCalledWith("/api/sessions/session-one/authority", expect.objectContaining({ method: "POST" }));
    expect(node.textContent).toContain("Tool access until");
    expect(node.querySelector("textarea")).toBe(draft); expect(draft?.value).toBe("Unsaved message");
  } finally { await act(async()=>root.unmount()); node.remove();vi.restoreAllMocks();vi.unstubAllGlobals(); }
});

it.each(["hour", "session"])("shows the Core-selected %s duration", async duration => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const node = document.createElement("div"); document.body.append(node); const root = createRoot(node);
  vi.mocked(appFetch).mockImplementation(async () => Response.json({ active: true, activeUntil: "2026-10-06T12:00:00Z", reviewUrl: "https://core.example/activity/assistants/harness/chat", duration }));
  try {
    await act(async () => root.render(<SessionAuthority sessionId="chat" />));
    if (duration === "session") {
      expect(node.textContent).toContain("until your Core sign-in session ends");
      expect(node.textContent).toContain("Manage tool access in Core");
    } else {
      expect(node.textContent).toContain("Tool access until");
      expect(node.textContent).toContain("Renew or revoke in Core");
    }
    expect(appFetch).toHaveBeenCalledWith("/api/sessions/chat/authority", expect.objectContaining({ method: "GET" }));
  } finally { await act(async () => root.unmount()); node.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); }
});
