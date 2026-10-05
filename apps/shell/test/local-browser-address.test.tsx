import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PublicOriginControl } from "../src/app/shell/pages/public-origin-control";
import { localBrowserPreview, localBrowserSettings } from "../src/app/shell/public-origin";
import type { CoreApp, CoreEndpoint } from "../src/app/shell/types";

const send = vi.hoisted(() => vi.fn(async () => Response.json({})));
vi.mock("../src/app/shell/shell-context", () => ({
  useShellState: () => ({ canManageApps: true, state: { status: { ingressProvider: "none" } } }),
  useShellActions: () => ({ coreOrigin: "https://core.test", sendCsrfJson: send, refresh: async () => {}, runAppAction: vi.fn() }),
}));
vi.mock("../src/components/reui/operation-toast", () => ({ toast: { success: vi.fn() } }));
const endpoint: CoreEndpoint = { key: "web", protocol: "http", public: true, url: "http://127.0.0.1:3100",
  browserOrigin: "http://aexamplez.hosty.localhost:3100", localOrigin: "http://aexamplez.hosty.localhost:3100",
  localDefaultOrigin: "http://aexamplez.hosty.localhost:3100", localSuffix: "hosty.localhost" };
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });
it("previews Core's assigned port and instance suffix without putting either in the saved label", () => {
  expect(localBrowserPreview({ ...endpoint, localSuffix: "i-instance.hosty.localhost" }, "media"))
    .toBe("http://media.i-instance.hosty.localhost:3100");
  expect(localBrowserPreview(endpoint, "")).toBe(endpoint.localDefaultOrigin);
  expect(localBrowserSettings("web", "Media")).toEqual({ HOSTY_LOCAL_NAME_WEB: "media", HOSTY_PUBLIC_ORIGIN_WEB: null });
});
it("edits only the local name and submits a stale-address precondition", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const node = document.createElement("div"); document.body.append(node);
  const root = createRoot(node);
  try {
    await act(async () => root.render(<PublicOriginControl app={{ id: "example.media", settings: [] } as unknown as CoreApp} endpoint={endpoint} />));
    await act(async () => node.querySelector<HTMLButtonElement>('button[aria-label="Configure browser address"]')!.click());
    expect(document.querySelector<HTMLInputElement>("#public-origin-url")).toBeNull();
    const input = document.querySelector<HTMLInputElement>("#local-browser-name")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "media-server");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(document.querySelector('[aria-label="Browser address preview"]')?.textContent).toBe("http://media-server.hosty.localhost:3100");
    const save = [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Save")!;
    await act(async () => save.click());
    expect(send).toHaveBeenCalledWith("https://core.test/api/apps/example.media/configure", {
      settings: { HOSTY_LOCAL_NAME_WEB: "media-server", HOSTY_PUBLIC_ORIGIN_WEB: null },
      expectedBrowserOrigins: { web: endpoint.browserOrigin },
    });
  } finally { await act(async () => root.unmount()); node.remove(); }
});
