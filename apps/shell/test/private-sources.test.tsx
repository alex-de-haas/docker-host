import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PrivateSourceConnections, SourceInstallDialog } from "../src/app/shell/dialogs/private-source-connections";
import { createInstallationClient } from "@hosty-sdk/app/install";
const send = vi.fn(); const refresh = vi.fn(async () => {});
vi.mock("../src/app/shell/shell-context", () => ({ useShellActions: () => ({ coreOrigin: "https://core.test", sendCsrfJson: send, refresh }) }));
let root: Root; let container: HTMLDivElement;
const connections = [
  { id: "personal", label: "Personal", accountName: "alice", provider: "github", organization: "", status: "connected" },
  { id: "work", label: "Work", accountName: "work-alice", provider: "azure-devops", organization: "acme", status: "connected" },
];
const access = { manifestUrl: "https://github.com/team/private/blob/main/manifest.json", status: "reconnect-required",
  access: { manifest: { connectionId: "missing", label: "Old", accountName: "alice", repository: "https://github.com/team/private.git" } } };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(url.endsWith("/api/profile") ? { connections } : access)));
  vi.spyOn(window, "open").mockReturnValue(null);
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: vi.fn() });
  send.mockReset(); refresh.mockClear();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function select(index: number, value: string) {
  await act(async () => { const input = document.querySelectorAll("select")[index]; input.value = value; input.dispatchEvent(new Event("change", { bubbles: true })); });
}
function button(text: string) { return [...document.querySelectorAll("button")].find(b => b.textContent?.includes(text))!; }
it("shows a missing grant and independently chooses replacement manifest and Git accounts", async () => {
  send.mockResolvedValueOnce(Response.json({ id: "review", status: "draft", approvalUrl: "https://core.test/install/confirm/review" })).mockResolvedValueOnce(Response.json({ id: "review", status: "pending", approvalUrl: "https://core.test/install/confirm/review" }))
    .mockImplementation(async () => Response.json({ id: "review", status: "pending", approvalUrl: "https://core.test/install/confirm/review" }));
  await act(async () => root.render(<PrivateSourceConnections appId="example.private" />));
  expect(container.textContent).toContain("Access is missing"); expect(container.textContent).toContain("Old (alice)");
  expect(button("Review source connections").disabled).toBe(true);
  await select(0, "personal"); await select(1, "work");
  await act(async () => button("Review source connections").click());
  expect(send).toHaveBeenCalledWith("https://core.test/api/installations", { updateAppId: "example.private", sourceConnections: { manifestConnectionId: "personal", gitConnectionId: "work" } }, "POST");
  expect(container.querySelector('a[target="_blank"]')?.getAttribute("href")).toBe("https://core.test/install/confirm/review");
});
it("preserves the account choices and shows a denied review without claiming success", async () => {
  send.mockResolvedValue(Response.json({ code: "source_access_required", message: "Wrong organization" }, { status: 409 }));
  await act(async () => root.render(<PrivateSourceConnections appId="example.private" />));
  await select(0, "work"); await act(async () => button("Review source connections").click());
  expect(container.textContent).toContain("Wrong organization");
  expect(container.querySelector("select")!.value).toBe("work"); expect(refresh).not.toHaveBeenCalled();
});
it("passes selected accounts through the existing installation review flow", async () => {
  send.mockResolvedValue(Response.json({ message: "Repository denied" }, { status: 409 }));
  const client = createInstallationClient({ baseUrl: "https://core.test/api/installations", request: send });
  await act(async () => root.render(<SourceInstallDialog client={client} source={{ manifestPath: access.manifestUrl }} coreOrigin="https://core.test" sendCsrfJson={send} onClose={() => {}} onInstalled={() => {}} />));
  await select(0, "personal"); await select(1, "work");
  await act(async () => button("Review installation").click());
  expect(send.mock.calls[0][1]).toMatchObject({ manifestPath: access.manifestUrl, sourceConnections: { manifestConnectionId: "personal", gitConnectionId: "work" } });
  expect(document.body.textContent).toContain("Repository denied");
});
