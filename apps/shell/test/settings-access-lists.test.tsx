import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsAccessList } from "../src/app/shell/pages/settings-access-lists";

type Grant = {
  id: string; label: string; appId: string; expiresAt?: string; revokedAt?: string;
  scopes: { id: string; kind: string; targetAppId: string; actions: string[]; providerKind?: string; key?: string }[];
};
type Client = { clientId: string; name: string; liveGrants: number; redirectUris: string[] };
let root: Root, container: HTMLDivElement;
let grants: Grant[], clients: Client[];
const send = vi.fn();
const activeId = "grant/active ?";
const grant = (id: string, label: string): Grant => ({ id, label, appId: `worker.${id}`,
  scopes: [{ id: `scope.${id}`, kind: "api", targetAppId: "worker.destination", actions: ["read"] }] });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  grants = [{ ...grant(activeId, "Nightly library index"), appId: "worker.indexer", expiresAt: "2099-01-01T00:00:00Z",
    scopes: [{ id: "scope.library", kind: "provider", targetAppId: "search.destination", actions: ["rebuild-index"], providerKind: "search-provider", key: "private-library" }] },
    { ...grant("revoked", "Retired export"), revokedAt: "2026-01-01T00:00:00Z" },
    { ...grant("expired", "Expired backup"), expiresAt: "2000-01-01T00:00:00Z" }];
  clients = [{ clientId: "client/editor ?", name: "Editor integration", liveGrants: 2, redirectUris: ["https://editor.example/callback"] },
    { clientId: "client-terminal", name: "Terminal integration", liveGrants: 0, redirectUris: ["https://terminal.example/auth"] }];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(url.includes("/oauth/clients") ? { clients } : grants)));
  send.mockImplementation(async () => Response.json({ status: "revoked" }));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); document.body.innerHTML = "";
  vi.resetAllMocks(); vi.unstubAllGlobals();
});
async function render({ kind = "background", actorId = "alice", coreOrigin = "https://core.test" }: {
  kind?: "background" | "oauth"; actorId?: string; coreOrigin?: string;
} = {}) {
  await act(async () => root.render(<SettingsAccessList coreOrigin={coreOrigin} actorId={actorId} kind={kind} sendCsrfJson={send} />));
}
function button(label: string) {
  const result = [...document.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === label || node.getAttribute("aria-label") === label);
  expect(result, `Missing button: ${label}`).toBeTruthy(); return result!;
}
async function click(label: string) { await act(async () => button(label).click()); }
async function openActions(name: string) {
  await act(async () => button(`Actions for ${name}`).dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 })));
}
async function chooseAction(label: string) {
  const action = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent === label);
  expect(action, `Missing action: ${label}`).toBeTruthy(); await act(async () => action!.click());
}
async function revoke(name = "Nightly library index") { await openActions(name); await chooseAction("Revoke access…"); }
async function search(value: string) {
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const rows = () => [...container.querySelectorAll<HTMLTableRowElement>("tbody tr")];

it("retains unrevoked, revoked and expired background authorization history with their factual status", async () => {
  await render();
  expect(fetch).toHaveBeenCalledWith("/api/core/api/auth/background-grants", expect.objectContaining({ signal: expect.any(AbortSignal), credentials: "same-origin" }));
  expect(rows()).toHaveLength(3);
  expect(rows()[0].textContent).toContain("Nightly library index"); expect(rows()[0].textContent).toContain("Not revoked");
  expect(rows()[1].textContent).toContain("Retired export"); expect(rows()[1].textContent).toContain("Revoked");
  expect(rows()[2].textContent).toContain("Expired backup"); expect(rows()[2].textContent).toContain("Expired");
  expect(container.querySelector('a[href="https://core.test/account/background"]')?.textContent).toBe("Authorize background work");
  await openActions("Retired export");
  expect(document.querySelector('[role="menuitem"]')?.getAttribute("aria-disabled")).toBe("true");
  expect(send).not.toHaveBeenCalled();
});

it("searches background names, apps and scope metadata and resets an explicit no-match result", async () => {
  await render();
  for (const query of ["  LIBRARY INDEX  ", "worker.indexer", "search.destination", "rebuild-index", "search-provider", "private-library"]) {
    await search(query); expect(rows()).toHaveLength(1); expect(rows()[0].textContent).toContain("Nightly library index");
  }
  await search("no matching authorization");
  expect(container.textContent).toContain("No authorizations match this search.");
  expect(container.textContent).not.toContain("Nightly library index");
  await click("Clear search"); expect(rows()).toHaveLength(3);
  expect(container.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe("");
});

it("reviews only the chosen background grant with its exact protected DELETE and retains history after success", async () => {
  send.mockImplementationOnce(async () => {
    grants = grants.map(item => item.id === activeId ? { ...item, revokedAt: "2026-10-23T12:00:00Z" } : item);
    return Response.json({ status: "revoked" });
  });
  await render(); await revoke();
  expect(send).toHaveBeenCalledExactlyOnceWith(`https://core.test/api/auth/background-grants/${encodeURIComponent(activeId)}`, undefined, "DELETE", expect.any(AbortSignal));
  expect(send.mock.calls.every(call => call[2] === "DELETE")).toBe(true);
  expect(rows()).toHaveLength(3); expect(rows()[0].textContent).toContain("Revoked");
  expect(rows()[1].textContent).toContain("Retired export"); expect(rows()[2].textContent).toContain("Expired backup");
  expect(fetch).toHaveBeenCalledTimes(2);
});

it.each([
  ["cancelled Core confirmation", "Core confirmation cancelled", true],
  ["refused Core mutation", "Core did not confirm this revocation.", false],
] as const)("keeps rows and access unchanged after a %s", async (_case, message, rejection) => {
  if (rejection) send.mockRejectedValueOnce(new Error(message));
  else send.mockResolvedValueOnce(Response.json({ message: "Permission denied" }, { status: 403 }));
  await render(); await revoke();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(message);
  expect(rows()).toHaveLength(3); expect(rows()[0].textContent).toContain("Not revoked");
  expect(rows()[1].textContent).toContain("Retired export"); expect(rows()[2].textContent).toContain("Expired backup");
  expect(fetch).toHaveBeenCalledTimes(1); expect(button("Actions for Nightly library index").disabled).toBe(false);
  expect(send).toHaveBeenCalledTimes(1); expect(send.mock.calls[0][2]).toBe("DELETE");
});

it("reports a failed initial read without claiming an empty authorization history", async () => {
  let fail!: (cause: Error) => void;
  vi.mocked(fetch).mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
  await render();
  expect(container.querySelector('[role="status"]')?.textContent).toContain("Loading authorizations");
  expect(container.textContent).not.toContain("No authorizations.");
  await act(async () => fail(new Error("Authorization service unavailable")));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Authorization service unavailable");
  expect(container.textContent).toContain("Authorizations could not be loaded.");
  expect(container.textContent).toContain("Unavailable"); expect(container.textContent).not.toContain("No authorizations.");
  expect(container.textContent).not.toContain("0 of 0 authorizations");
});

it("aborts and ignores an old actor's late list response", async () => {
  let finish!: (response: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await render();
  const previousSignal = vi.mocked(fetch).mock.calls[0][1]?.signal;
  grants = [grant("bob", "Bob background task")]; await render({ actorId: "bob" });
  expect(previousSignal?.aborted).toBe(true);
  await act(async () => finish(Response.json([grant("alice-stale", "Stale Alice authorization")])));
  expect(rows()).toHaveLength(1); expect(rows()[0].textContent).toContain("Bob background task");
  expect(container.textContent).not.toContain("Stale Alice authorization"); expect(send).not.toHaveBeenCalled();
});

it("does not continue an old actor's pending revocation after the actor changes", async () => {
  let finish!: (response: Response) => void;
  send.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await render(); await revoke();
  expect(container.querySelector('[role="status"]')?.textContent).toContain("Reviewing revocation in Core");
  const previousSignal = send.mock.calls[0][3] as AbortSignal;
  grants = [grant("bob", "Bob background task")]; await render({ actorId: "bob" });
  expect(previousSignal.aborted).toBe(true);
  const reads = vi.mocked(fetch).mock.calls.length;
  await act(async () => finish(Response.json({ status: "revoked" })));
  expect(fetch).toHaveBeenCalledTimes(reads); expect(send).toHaveBeenCalledTimes(1);
  expect(rows()).toHaveLength(1); expect(rows()[0].textContent).toContain("Bob background task");
  expect(container.textContent).not.toContain("Nightly library index");
  expect(container.querySelector('[role="alert"]')).toBeNull(); expect(button("Refresh").disabled).toBe(false);
});

it("preserves OAuth client listing, identifier/redirect search and exact single-client removal", async () => {
  await render({ kind: "oauth" });
  expect(fetch).toHaveBeenCalledWith("/api/core/api/auth/oauth/clients", expect.objectContaining({ signal: expect.any(AbortSignal), credentials: "same-origin" }));
  expect(rows()).toHaveLength(2); expect(rows()[0].textContent).toContain("2 active authorizations");
  expect(container.querySelector('a[href$="/account/background"]')).toBeNull();
  await search("editor.example/callback"); expect(rows()).toHaveLength(1); expect(rows()[0].textContent).toContain("Editor integration");
  await search("client-terminal"); expect(rows()).toHaveLength(1); expect(rows()[0].textContent).toContain("Terminal integration");
  await search("");
  send.mockImplementationOnce(async () => { clients = clients.slice(1); return Response.json({ status: "removed" }); });
  await openActions("Editor integration"); await chooseAction("Remove client…");
  expect(send).toHaveBeenCalledExactlyOnceWith(`https://core.test/api/auth/oauth/clients/${encodeURIComponent("client/editor ?")}`, undefined, "DELETE", expect.any(AbortSignal));
  expect(rows()).toHaveLength(1); expect(rows()[0].textContent).toContain("Terminal integration");
  expect(container.textContent).not.toContain("Editor integration");
});
