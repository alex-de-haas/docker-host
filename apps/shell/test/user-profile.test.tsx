import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { UserProfilePage } from "../src/app/shell/pages/user-profile-page";
let root: Root; let container: HTMLDivElement;
const send = vi.fn(); const saved = vi.fn(async () => {});
const connection = { id: "personal", label: "Personal", provider: "github", accountName: "octocat", organization: "", status: "connected", method: "pat" };
const profile = { id: "alice", displayName: "Alice", email: "alice@example.test", connections: [connection, { ...connection, id: "work", label: "Work", accountName: "work-account" }], providers: { gitHubDevice: true, azureDevice: true } };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(profile)));
  send.mockImplementation(async () => Response.json(profile));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.resetAllMocks(); vi.unstubAllGlobals(); });
const render = () => act(async () => root.render(<UserProfilePage coreOrigin="https://core.test" sendCsrfJson={send} onSaved={saved} />));
const button = (text: string) => [...container.querySelectorAll("button")].find(b => b.textContent === text)!;
async function fill(id: string, value: string) {
  await act(async () => {
    const node = container.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`)!;
    const prototype = node instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event(node instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}
it("loads only the current profile and saves only the display name", async () => {
  await render();
  expect(fetch).toHaveBeenCalledWith("/api/core/api/profile", expect.objectContaining({ credentials: "same-origin", cache: "no-store" }));
  expect(container.textContent).not.toContain("octocat"); expect(container.textContent).not.toContain("Connected accounts");
  await fill("profile-name", "New name");
  await act(async () => button("Save profile").click());
  expect(send).toHaveBeenCalledWith("https://core.test/api/profile", { displayName: "New name"}, "PUT");
  expect(saved).toHaveBeenCalledOnce();
});
it("reports a failed profile save", async () => {
  await render(); send.mockRejectedValueOnce(new Error("Save unavailable"));
  await act(async () => button("Save profile").click());
  expect(container.querySelector('[role="alert"]')!.textContent).toBe("Save unavailable");
  expect(saved).not.toHaveBeenCalled();
});
