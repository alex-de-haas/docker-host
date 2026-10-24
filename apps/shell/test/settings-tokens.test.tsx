import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsTokensSection } from "../src/app/shell/pages/settings-tokens-section";
import type { Credential } from "../src/app/shell/pages/settings-credential-grid";
let root: Root, container: HTMLDivElement;
const send = vi.fn();
const credential = (id: string, kind = "manual"): Credential => ({ id, kind, label: id, scopes: ["mcp:read"], createdAt: "2026-10-01T12:00:00Z", lastSeenAt: "2026-10-02T12:00:00Z" });
let rows: Credential[];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  rows = [credential("script-fingerprint"), credential("browser-fingerprint", "browser"), { ...credential("oauth-fingerprint", "oauth"), label: "Connected client", oauthClientName: "Agent", audience: "hosty:core", scopes: ["mcp:read", "mcp:write"] }];
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ credentials: rows })));
  send.mockImplementation(async () => Response.json({ status: "revoked" }));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); document.body.innerHTML = ""; vi.resetAllMocks(); vi.unstubAllGlobals(); });
async function render(userId?: string, coreOrigin = "https://core.test", actorId = "alice") { await act(async () => root.render(<SettingsTokensSection coreOrigin={coreOrigin} sendCsrfJson={send} userId={userId} actorId={actorId} />)); }
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === label || node.getAttribute("aria-label") === label)!;
async function click(label: string) { await act(async () => button(label).click()); }
async function open(label: string) { await act(async () => button(label).dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }))); }
async function fill(label: string, value: string) {
  await act(async () => { const input = [...document.querySelectorAll<HTMLInputElement>("input")].find(node => node.getAttribute("aria-label") === label || document.querySelector(`label[for="${node.id}"]`)?.textContent === label)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}
const dataRows = () => [...container.querySelectorAll("tbody tr")];
async function choose(role: string, text: string) {
  const item = [...document.querySelectorAll<HTMLElement>(`[role="${role}"]`)].find(node => node.textContent?.startsWith(text))!;
  expect(item, `Missing ${role}: ${text}`).toBeTruthy(); await act(async () => item.click());
}
async function escape() { await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))); }
it("lists metadata and preserves current-user Core creation flows", async () => {
  await render();
  expect(fetch).toHaveBeenCalledWith("/api/core/api/auth/credentials", expect.objectContaining({ signal: expect.any(AbortSignal), credentials: "same-origin" }));
  expect(container.querySelector('a[href="https://core.test/account/tokens"]')?.textContent).toBe("Create token");
  expect(container.querySelector('a[href="https://core.test/account/device"]')?.textContent).toBe("Connect device");
  expect(dataRows()).toHaveLength(3); expect(container.textContent).not.toContain("Current device");
});
it("searches scopes, client metadata and fingerprints with an explicit no-match reset", async () => {
  await render(); await fill("Search tokens and devices", "mcp:write");
  expect(dataRows()).toHaveLength(1); expect(dataRows()[0].textContent).toContain("Connected client");
  await fill("Search tokens and devices", "script-fingerprint"); expect(dataRows()[0].textContent).toContain("script-fingerprint");
  await fill("Search tokens and devices", "not present"); expect(container.textContent).toContain("No credentials match these filters.");
  await click("Clear filters"); expect(dataRows()).toHaveLength(3);
});
it("filters factual kinds with counts, exposes optional columns and applies density", async () => {
  await render(); await open("Type"); await choose("menuitemcheckbox", "OAuth");
  expect(dataRows()).toHaveLength(1); expect(dataRows()[0].textContent).toContain("Connected client");
  await escape(); await open("Choose columns"); await choose("menuitemcheckbox", "Fingerprint");
  expect(dataRows()[0].textContent).toContain("oauth-fingerprint");
  await escape(); await open("Row density"); await choose("menuitemradio", "Compact");
  expect(dataRows()[0].className).toContain("h-9");
});
it("sorts and paginates while preserving selected rows without selecting unseen rows", async () => {
  rows = Array.from({ length: 12 }, (_, i) => credential(`Token ${String(i + 1).padStart(2, "0")}`));
  await render(); await click("Sort by Name");
  expect(dataRows()).toHaveLength(10); expect(dataRows()[0].textContent).toContain("Token 01");
  await click("Select this page"); expect(container.textContent).toContain("10 selected");
  await click("Next"); expect(dataRows()).toHaveLength(2); expect(dataRows()[0].textContent).toContain("Token 11");
  expect(button("Select this page").getAttribute("aria-checked")).toBe("false");
  await click("Select Token 11"); expect(button("Select this page").getAttribute("aria-checked")).toBe("mixed");
  expect(container.textContent).toContain("11 selected"); await click("Previous"); expect(button("Select this page").getAttribute("aria-checked")).toBe("true");
});
it("keeps an unsaved rename through refresh and after a rejected save", async () => {
  await render(); await open("Actions for script-fingerprint"); await choose("menuitem", "Rename");
  await fill("Credential name", "My edited name"); rows = rows.map(row => ({ ...row, label: "Server changed name" }));
  await click("Refresh"); expect([...container.querySelectorAll<HTMLInputElement>("input")].some(input => input.value === "My edited name")).toBe(true);
  send.mockRejectedValueOnce(new Error("Rename refused"));
  await act(async () => button("Save name").closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(send).toHaveBeenCalledWith("https://core.test/api/auth/credentials/script-fingerprint/label", { label: "My edited name" }, "PATCH", expect.any(AbortSignal));
  expect(container.textContent).toContain("Rename refused"); expect([...container.querySelectorAll<HTMLInputElement>("input")].some(input => input.value === "My edited name")).toBe(true);
});
it("revokes sequentially with Core review and preserves remaining selection after partial failure", async () => {
  await render(); await click("Select this page"); let finishFirst!: (value: Response) => void;
  send.mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; })).mockRejectedValueOnce(new Error("Core confirmation cancelled"));
  await act(async () => button("Review revoke (3)").click()); expect(send).toHaveBeenCalledTimes(1); expect(container.textContent).toContain("Reviewing revocation 1 of 3 in Core");
  rows = rows.slice(1); await act(async () => finishFirst(Response.json({ status: "revoked" })));
  expect(send).toHaveBeenCalledTimes(2); expect(send.mock.calls.map(call => call[0])).toEqual(["https://core.test/api/auth/credentials/script-fingerprint", "https://core.test/api/auth/credentials/browser-fingerprint"]);
  expect(container.textContent).toContain("1 of 3 revoked. Core confirmation cancelled"); expect(container.textContent).toContain("2 selected"); expect(button("Review revoke (2)").disabled).toBe(false);
});
it("stops a bulk mutation when its user scope changes", async () => {
  await render(); await click("Select this page"); let finish!: (response: Response) => void;
  send.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => button("Review revoke (3)").click()); rows = [credential("Bob's device", "device")];
  await render("bob"); await act(async () => finish(Response.json({ status: "revoked" })));
  expect(send).toHaveBeenCalledTimes(1); expect(send.mock.calls[0][3].aborted).toBe(true);
  expect(container.textContent).toContain("Bob's device"); expect(container.textContent).not.toContain("selected");
  expect(container.querySelector('a[href$="/account/tokens"]')).toBeNull(); expect(container.querySelector('a[href$="/account/device"]')).toBeNull();
  expect(fetch).toHaveBeenLastCalledWith("/api/core/api/auth/credentials?userId=bob", expect.anything());
});
it("ignores a stale list response after changing the selected user", async () => {
  let finish!: (response: Response) => void; vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await render(); rows = [credential("Bob only")]; await render("bob"); await act(async () => finish(Response.json({ credentials: [credential("Stale Alice")] })));
  expect(container.textContent).toContain("Bob only"); expect(container.textContent).not.toContain("Stale Alice");
});
it("shows animated loading and failure without claiming an empty account", async () => {
  let fail!: (error: Error) => void; vi.mocked(fetch).mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
  await render(); expect(container.querySelector('[role="status"]')?.textContent).toContain("Loading tokens and devices"); expect(container.textContent).not.toContain("No active tokens or devices");
  await act(async () => fail(new Error("Credential service unavailable")));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Credential service unavailable"); expect(container.textContent).not.toContain("No active tokens or devices");
});

it("clears current-user rows and ignores late data when the signed-in actor changes", async () => {
  let finish!: (response: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await render(); rows = [credential("Bob personal device")]; await render(undefined, "https://core.test", "bob");
  await act(async () => finish(Response.json({ credentials: [credential("Alice personal device")] })));
  expect(container.textContent).toContain("Bob personal device"); expect(container.textContent).not.toContain("Alice personal device");
  expect(fetch).toHaveBeenLastCalledWith("/api/core/api/auth/credentials", expect.anything());
});

it("keeps distinct OAuth client identifiers inspectable when friendly names match", async () => {
  rows = [{ ...credential("grant-one", "oauth"), label: "Agent", oauthClientName: "Same agent", oauthClientId: "client-one" },
    { ...credential("grant-two", "oauth"), label: "Agent", oauthClientName: "Same agent", oauthClientId: "client-two" }];
  await render(); expect(container.textContent).not.toContain("client-one");
  await open("Choose columns"); await choose("menuitemcheckbox", "OAuth client"); await escape();
  expect(dataRows()[0].textContent).toContain("Same agentclient-one");
  expect(dataRows()[1].textContent).toContain("Same agentclient-two");
  await fill("Search tokens and devices", "client-two");
  expect(dataRows()).toHaveLength(1); expect(dataRows()[0].textContent).toContain("client-two");
  await click("Select this page"); await click("Review revoke (1)");
  expect(send).toHaveBeenCalledWith("https://core.test/api/auth/credentials/grant-two", undefined, "DELETE", expect.any(AbortSignal));
});

const revokeAllLabel = "Revoke all my authorizations";

async function renderRevokeAll(options: { canRevokeAll?: boolean; userId?: string; actorId?: string; coreOrigin?: string } = {}) {
  await act(async () => root.render(<SettingsTokensSection
    coreOrigin={options.coreOrigin ?? "https://core.test"}
    actorId={options.actorId ?? "alice"}
    userId={options.userId}
    canRevokeAll={options.canRevokeAll}
    sendCsrfJson={send}
  />));
}

function mockRevokeAllNavigation() {
  const navigate = vi.fn();
  const currentWindow = window;
  const location = { ...currentWindow.location, assign: navigate };
  // JSDOM's Location.assign is unforgeable. Keep its URL fields for authenticated reads.
  vi.stubGlobal("window", new Proxy(currentWindow, {
    get(target, key) {
      if (key === "location") return location;
      return Reflect.get(target, key, target);
    },
  }));
  return navigate;
}

it("offers global revocation only for an explicitly enabled current-user view", async () => {
  await renderRevokeAll();
  expect(button(revokeAllLabel)).toBeUndefined();
  await renderRevokeAll({ canRevokeAll: true });
  expect(button(revokeAllLabel)).toBeTruthy();
  await renderRevokeAll({ canRevokeAll: false });
  expect(button(revokeAllLabel)).toBeUndefined();
  await renderRevokeAll({ canRevokeAll: true, userId: "bob" });
  expect(button(revokeAllLabel)).toBeUndefined();
  expect(send).not.toHaveBeenCalled();
});

it("keeps one reviewed global request pending and navigates only after Core confirms success", async () => {
  await renderRevokeAll({ canRevokeAll: true, coreOrigin: "https://selected-core.test" });
  const navigate = mockRevokeAllNavigation();
  let finish!: (response: Response) => void;
  send.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const action = button(revokeAllLabel);
  // Both clicks precede the next render, so the mutation guard must also reject duplicates.
  await act(async () => { action.click(); action.click(); });
  expect(send).toHaveBeenCalledExactlyOnceWith(
    "https://selected-core.test/api/auth/background-grants/revoke-all-authorizations",
    {},
    "POST",
    expect.any(AbortSignal),
  );
  expect(send.mock.calls[0][3].aborted).toBe(false);
  expect(action.disabled).toBe(true);
  expect(container.textContent).toContain("Reviewing revocation of all your access in Core");
  expect(navigate).not.toHaveBeenCalled();
  await act(async () => finish(Response.json({ status: "revoked" })));
  expect(navigate).toHaveBeenCalledExactlyOnceWith("https://selected-core.test/login");
});

it.each(["Core confirmation cancelled", "Core request failed"])(
  "keeps credentials and shows refusal without navigating after %s",
  async message => {
    await renderRevokeAll({ canRevokeAll: true });
    const navigate = mockRevokeAllNavigation();
    send.mockRejectedValueOnce(new Error(message));
    await click(revokeAllLabel);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(message);
    expect(dataRows()).toHaveLength(3);
    expect(button(revokeAllLabel).disabled).toBe(false);
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  },
);

it("does not navigate or claim success when Core returns a non-success global revocation response", async () => {
  await renderRevokeAll({ canRevokeAll: true });
  const navigate = mockRevokeAllNavigation();
  send.mockResolvedValueOnce(Response.json({ code: "review_refused" }, { status: 403 }));
  await click(revokeAllLabel);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Core did not confirm revocation of all your access.");
  expect(container.querySelector('[role="status"]')).toBeNull();
  expect(dataRows()).toHaveLength(3);
  expect(button(revokeAllLabel).disabled).toBe(false);
  expect(navigate).not.toHaveBeenCalled();
});

it("aborts a global revocation when the signed-in actor changes and ignores its late success", async () => {
  await renderRevokeAll({ canRevokeAll: true });
  const navigate = mockRevokeAllNavigation();
  let finish!: (response: Response) => void;
  send.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await click(revokeAllLabel);
  const signal = send.mock.calls[0][3] as AbortSignal;
  rows = [credential("Bob's current token")];
  await renderRevokeAll({ canRevokeAll: true, actorId: "bob" });
  expect(signal.aborted).toBe(true);
  await act(async () => finish(Response.json({ status: "revoked" })));
  expect(navigate).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("Bob's current token");
  expect(container.textContent).not.toContain("script-fingerprint");
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelector('[role="status"]')).toBeNull();
  expect(button(revokeAllLabel).disabled).toBe(false);
});
