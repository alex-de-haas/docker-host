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
it("loads the user's accounts and saves their display name through Core", async () => {
  await render();
  expect(fetch).toHaveBeenCalledWith("https://core.test/api/profile", expect.objectContaining({ credentials: "include", cache: "no-store" }));
  expect(container.textContent).toContain("octocat"); expect(container.textContent).toContain("work-account");
  await fill("profile-name", "New name");
  await act(async () => button("Save profile").click());
  expect(send).toHaveBeenCalledWith("https://core.test/api/profile", { displayName: "New name", gitIdentity: null, updateGitIdentity: true }, "PUT");
  expect(saved).toHaveBeenCalledOnce();
});
it("offers PAT fallback when OAuth is not configured and clears rejected tokens", async () => {
  vi.mocked(fetch).mockImplementation(async () => Response.json({ ...profile, providers: { gitHubDevice: false, azureDevice: false } }));
  await render(); await act(async () => button("Add connection").click());
  expect(container.textContent).toContain("not configured"); expect(button("Connect account").disabled).toBe(true);
  await fill("connection-label", "Another account"); await fill("connection-method", "pat"); await fill("connection-token", "never-store-in-ui");
  send.mockRejectedValueOnce(new Error("Provider access denied"));
  await act(async () => button("Connect account").click());
  expect(send).toHaveBeenCalledWith("https://core.test/api/profile/connections/pat", expect.objectContaining({ token: "never-store-in-ui", provider: "github" }));
  expect(container.querySelector<HTMLInputElement>("#connection-token")!.value).toBe("");
  expect(container.querySelector('[role="alert"]')!.textContent).toBe("Provider access denied");
});
it("respects the device polling interval and cancels its pending attempt", async () => {
  vi.useFakeTimers(); await render(); await act(async () => button("Add connection").click()); await fill("connection-label", "GitHub");
  const pending = { id: "attempt", status: "pending", userCode: "ABCD-EFGH", verificationUri: "https://github.com/login/device", expiresAt: "2026-09-28T12:00:00Z", interval: 10 };
  send.mockImplementation(async () => Response.json(pending));
  await act(async () => button("Connect account").click());
  expect(container.textContent).toContain("ABCD-EFGH");
  await act(async () => vi.advanceTimersByTimeAsync(9000)); expect(send).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(send).toHaveBeenLastCalledWith("https://core.test/api/profile/connections/device/attempt/poll", {});
  await act(async () => button("Cancel").click());
  expect(send).toHaveBeenLastCalledWith("https://core.test/api/profile/connections/device/attempt", undefined, "DELETE");
  const count = send.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(30000)); expect(send).toHaveBeenCalledTimes(count);
});
it("disconnects only the confirmed account and keeps a failed rename editable", async () => {
  await render(); await act(async () => button("Rename").click());
  send.mockRejectedValueOnce(new Error("Network unavailable"));
  await act(async () => button("Save").click());
  expect(container.querySelector('[aria-label="Name for Personal"]')).not.toBeNull();
  await act(async () => button("Cancel rename").click());
  await act(async () => button("Disconnect").click());
  expect(send).toHaveBeenCalledTimes(1);
  await act(async () => button("Remove connection").click());
  expect(send).toHaveBeenLastCalledWith("https://core.test/api/profile/connections/personal", undefined, "DELETE");
});

it("saves explicit Git identity separately from the connected account", async () => {
  await render(); await fill("git-name", "Git Author"); await fill("git-email", "author@example.test");
  await act(async () => button("Save profile").click());
  expect(send).toHaveBeenCalledWith("https://core.test/api/profile", { displayName: "Alice", updateGitIdentity: true, gitIdentity: { name: "Git Author", email: "author@example.test" } }, "PUT");
});
