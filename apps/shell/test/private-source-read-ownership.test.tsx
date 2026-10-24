import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PrivateSourceConnections } from "../src/app/shell/dialogs/private-source-connections";
const fixture = vi.hoisted(() => ({
  read: vi.fn(), send: vi.fn(),
  request: { status: "succeeded", id: "finished" } as { status: string; id: string } | null,
  flow: { clearReview: vi.fn(), snapshot: () => ({ busy: false, uncertainSubmit: false }), review: vi.fn(), submit: vi.fn(), refresh: vi.fn() },
}));
vi.mock("../src/app/shell/core-transport.js", () => ({ fetchCore: fixture.read }));
vi.mock("../src/app/shell/shell-context", () => ({ useShellActions: () => ({ coreOrigin: "https://core.test", sendCsrfJson: fixture.send }) }));
vi.mock("@hosty-sdk/app/install/react", () => ({ InstallDialog: () => null, useInstallation: () => ({ flow: fixture.flow, request: fixture.request, busy: false, error: null, uncertainSubmit: false }) }));
let root: Root, node: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.read.mockReset(); fixture.send.mockReset(); fixture.request = { status: "succeeded", id: "finished" };
  node = document.createElement("div"); document.body.append(node); root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); node.remove(); vi.unstubAllGlobals(); });
const render = (active = true) => act(async () => root.render(<PrivateSourceConnections appId="example.private" active={active} />));
it("an old terminal Refresh connections cannot overwrite a newer reopened observation", async () => {
  let phase = 0;
  let completeOld!: (value: Response) => void;
  let oldSignal: AbortSignal | undefined;
  const profile = (id: string) => ({ connections: [{ id, label: `${id} account`, status: "connected" }] });
  const access = (id: string) => ({ status: "available", hasGitSource: true, access: { git: { connectionId: id } } });
  fixture.read.mockImplementation(async (url: string, init?: RequestInit) => {
    if (phase === 1 && url.endsWith("/source-access")) {
      oldSignal = init?.signal as AbortSignal;
      return await new Promise<Response>(resolve => { completeOld = resolve; });
    }
    const id = phase === 2 ? "second" : "first";
    return Response.json(url.endsWith("/source-access") ? access(id) : profile(id));
  });
  await render(); expect(node.textContent).toContain("first account");
  phase = 1;
  await act(async () => [...node.querySelectorAll("button")].find(button => button.textContent === "Refresh connections")!.click());
  fixture.request = null;
  await render(false); phase = 2; await render();
  expect(oldSignal?.aborted).toBe(true); expect(node.textContent).toContain("second account");
  await act(async () => completeOld(Response.json(access("first"))));
  expect(node.textContent).toContain("second account"); expect(node.textContent).not.toContain("first account");
  expect(fixture.send).not.toHaveBeenCalled();
});
