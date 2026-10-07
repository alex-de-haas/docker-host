// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SourceProviders } from "../src/app/shell/pages/source-providers";
const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("../src/app/shell/source/source-connections", () => ({ createSourceConnectionsApi: () => ({ call, send: (url: string, body?: unknown, method = "POST") => call(url, { method, body: body === undefined ? undefined : JSON.stringify(body) }) }) }));
let root: Root; let container: HTMLDivElement;
const send = vi.fn();
const connection = { id: "personal", label: "Personal", provider: "github", accountName: "octocat", organization: "", status: "connected", method: "pat" };
const profile = { id: "alice", displayName: "Alice", email: "alice@example.test", connections: [connection, { ...connection, id: "work", label: "Work", accountName: "work-account" }], providers: [{ id: "github", displayName: "GitHub", authenticationMethods: ["device", "pat"], capabilities: [] }] };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.mocked(call).mockImplementation(async (url, init) => init?.method ? send(url, init.body === undefined ? undefined : JSON.parse(init.body as string), init.method) : Response.json(profile));
  send.mockImplementation(async () => Response.json(profile));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.resetAllMocks(); vi.unstubAllGlobals(); });
const render = () => act(async () => root.render(<SourceProviders coreOrigin="https://core.test" sendCsrfJson={send} />));
const button = (text: string) => [...document.querySelectorAll("button")].find(b => b.textContent === text)!;
async function fill(id: string, value: string) {
  await act(async () => {
    const node = document.querySelector<HTMLInputElement>(`#${id}`)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function choose(id: string, label: string) {
  const trigger = document.getElementById(id)!;
  expect(trigger.getAttribute("role")).toBe("combobox");
  await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  const option = [...document.querySelectorAll('[role="option"]')].find(node => node.textContent === label)!;
  expect(option).toBeDefined();
  await act(async () => option.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
}
it("offers PAT fallback when OAuth is not configured and clears rejected tokens", async () => {
  vi.mocked(call).mockImplementation(async (url, init) => init?.method ? send(url, init.body === undefined ? undefined : JSON.parse(init.body as string), init.method) : Response.json({ ...profile, providers: [{ id: "github", displayName: "GitHub", authenticationMethods: ["pat"], capabilities: [] }] }));
  await render(); await act(async () => button("Add connection").click());
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain("not configured"); expect(button("Connect GitHub").disabled).toBe(true);
  await act(async () => button("Use a personal access token").click()); await fill("connection-label", "Another account"); await fill("connection-token", "never-store-in-ui");
  send.mockRejectedValueOnce(new Error("Provider access denied"));
  await act(async () => button("Connect account").click());
  expect(send).toHaveBeenCalledWith("/source-connections/pat", expect.objectContaining({ token: "never-store-in-ui", provider: "github" }), "POST");
  expect(document.querySelector<HTMLInputElement>("#connection-token")!.value).toBe("");
  expect(document.querySelector('[role="dialog"] [role="alert"]')!.textContent).toBe("Provider access denied");
});
it.each(["Cancel", "Close", "Escape"])("respects the device polling interval and cancels its pending attempt with %s", async dismiss => {
  vi.useFakeTimers(); await render(); await act(async () => button("Add connection").click());
  const pending = { id: "attempt", status: "pending", userCode: "ABCD-EFGH", verificationUri: "https://github.com/login/device", expiresAt: "2026-09-28T12:00:00Z", interval: 10 };
  send.mockImplementation(async () => Response.json(pending));
  expect(button("Connect GitHub").disabled).toBe(false);
  expect(document.querySelector("#connection-label")).toBeNull();
  await act(async () => button("Connect GitHub").click());
  expect(send).toHaveBeenCalledWith("/source-connections/device", expect.objectContaining({ label: "", provider: "github", privateRepositories: false }), "POST");
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain("ABCD-EFGH");
  await act(async () => vi.advanceTimersByTimeAsync(9000)); expect(send).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(send).toHaveBeenLastCalledWith("/source-connections/device/attempt/poll", {}, "POST");
  await act(async () => {
    if (dismiss === "Escape") document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    else button(dismiss).click();
  });
  expect(send).toHaveBeenLastCalledWith("/source-connections/device/attempt", undefined, "DELETE");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  const count = send.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(30000)); expect(send).toHaveBeenCalledTimes(count);
});
it("opens a modal and clears the unsaved form on dismissal", async () => {
  await render(); await act(async () => button("Add connection").click());
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(container.querySelector("#connection-label")).toBeNull();
  await act(async () => button("Additional options").click());
  await fill("connection-label", "Draft"); await choose("connection-method", "Personal access token"); await fill("connection-token", "unsaved-token");
  await act(async () => button("Close").click());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(send).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(document.activeElement).toBe(button("Add connection")));
  await act(async () => button("Add connection").click());
  expect(document.querySelector("#connection-label")).toBeNull();
  await act(async () => button("Additional options").click());
  expect(document.querySelector<HTMLInputElement>("#connection-label")!.value).toBe("");
  await choose("connection-method", "Personal access token");
  expect(document.querySelector<HTMLInputElement>("#connection-token")!.value).toBe("");
});
it("keeps a pending submission open and closes after the account connects", async () => {
  await render(); await act(async () => button("Add connection").click());
  await act(async () => button("Additional options").click());
  await fill("connection-label", "New account"); await choose("connection-method", "Personal access token"); await fill("connection-token", "submitted-token");
  let resolve!: (response: Response) => void;
  send.mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; }));
  await act(async () => button("Connect account").click());
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(button("Cancel").disabled).toBe(true);
  await act(async () => resolve(Response.json(connection)));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(container.textContent).toContain("Account connected.");
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
  expect(send).toHaveBeenLastCalledWith("/source-connections/personal", undefined, "DELETE");
});

it("saves explicit Git identity separately from the connected account", async () => {
  await render(); await fill("git-name", "Git Author"); await fill("git-email", "author@example.test");
  await act(async () => button("Save Git identity").click());
  expect(send).toHaveBeenCalledWith("/source-connections/identity", { gitIdentity: { name: "Git Author", email: "author@example.test" } }, "PUT");
});

it("shows unsupported saved accounts but never offers Azure as a new provider", async () => {
  call.mockResolvedValue(Response.json({ ...profile, connections: [{ ...connection, provider: "azure-devops", status: "unsupported" }] }));
  await render();
  expect(container.textContent).toContain("Azure DevOps (unsupported)");
  expect(button("Check connection").disabled).toBe(true);
  expect(button("Disconnect").disabled).toBe(false);
  expect(container.textContent).not.toContain("Application sources");
  await act(async () => button("Add connection").click());
  await act(async () => document.getElementById("connection-provider")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  expect([...document.querySelectorAll('[role="option"]')].map(node => node.textContent)).toEqual(["GitHub"]);
});
