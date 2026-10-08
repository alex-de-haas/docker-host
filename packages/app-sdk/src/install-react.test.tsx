// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InstallDialog } from "./install-react";
import type { InstallationClient, InstallationRequest } from "./install";

let root: Root;
let container: HTMLDivElement;
const draft: InstallationRequest = {
  id: "a".repeat(48), status: "draft", expiresAt: "2099-01-01T00:00:00Z",
  approvalUrl: "https://core.example/install/confirm/one",
  plan: { appId: "example.app", displayName: "Example", action: "install", targetVersion: "1.0.0",
    targetRuntime: "docker", targetRuntimeType: "docker", targetManifestDigest: "digest", manifestPath: "app.json",
    settings: [{ key: "API_KEY", type: "string", secret: true, required: true, defaultValue: "never-display" }] },
};
function client(): InstallationClient {
  return { prepare: vi.fn(async () => draft), submit: vi.fn(async () => ({ ...draft, status: "pending" })), status: vi.fn(async () => ({ ...draft, status: "pending" })) };
}
function popup() {
  return { closed: false, opener: {}, location: { replace: vi.fn() }, close: vi.fn() } as unknown as Window;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: vi.fn() });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("goes straight to Core with the frozen channel and no settings questionnaire", async () => {
  const api = client(); const confirmationWindow = popup();
  const source = { feedsUrl: "https://apps.example/feeds.json", feedId: "beta", sourceConnections: { manifestConnectionId: "account" } };
  await act(async () => root.render(<InstallDialog client={api} source={source} confirmationWindow={confirmationWindow} onClose={() => {}} />));
  expect(api.prepare).toHaveBeenCalledExactlyOnceWith(source);
  expect(api.submit).toHaveBeenCalledExactlyOnceWith(draft.id, undefined, undefined);
  expect(confirmationWindow.location.replace).toHaveBeenCalledExactlyOnceWith(draft.approvalUrl);
  expect(confirmationWindow.opener).toBeNull();
  expect(container.querySelector("input,select")).toBeNull();
  expect(container.textContent).not.toContain("API_KEY");
  expect(container.innerHTML).not.toContain("never-display");
});
it("opens its popup during the source form gesture before preparing a request", async () => {
  const api = client(); const confirmationWindow = popup();
  const open = vi.spyOn(window, "open").mockReturnValue(confirmationWindow);
  vi.mocked(api.prepare).mockImplementation(async () => {
    expect(open).toHaveBeenCalledTimes(1);
    return draft;
  });
  await act(async () => root.render(<InstallDialog client={api} onClose={() => {}} />));
  const input = container.querySelector("input")!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, "https://apps.example/app.json");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(api.prepare).toHaveBeenCalledExactlyOnceWith({ manifestPath: "https://apps.example/app.json" });
  expect(open).toHaveBeenCalledWith("about:blank", "_blank", "popup,width=640,height=720");
  expect(confirmationWindow.location.replace).toHaveBeenCalledOnce();
});
it("keeps the confirmation link when the caller's popup was blocked", async () => {
  await act(async () => root.render(<InstallDialog client={client()} source={{ manifestPath: "app.json" }} confirmationWindow={null} onClose={() => {}} />));
  expect(container.querySelector("a")?.href).toBe(draft.approvalUrl);
  expect(container.textContent).toContain("Confirm runtime, automatic startup and permissions in Hosty Core.");
});
it("requires a fresh request when the selected channel changes during preparation", async () => {
  const api = client(); let resolveOld!: (request: InstallationRequest) => void;
  vi.mocked(api.prepare).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
  await act(async () => root.render(<InstallDialog client={api} source={{ feedsUrl: "https://apps.example/feeds.json", feedId: "stable" }} onClose={() => {}} />));
  await act(async () => root.render(<InstallDialog client={api} source={{ feedsUrl: "https://apps.example/feeds.json", feedId: "beta" }} onClose={() => {}} />));
  await act(async () => resolveOld({ ...draft, id: "old-channel" }));
  expect(api.prepare).toHaveBeenCalledTimes(2);
  expect(api.prepare).toHaveBeenLastCalledWith({ feedsUrl: "https://apps.example/feeds.json", feedId: "beta" });
  expect(api.submit).toHaveBeenCalledExactlyOnceWith(draft.id, undefined, undefined);
});
it("resolves an uncertain submit with status checks without preparing or submitting again", async () => {
  const api = client();
  vi.mocked(api.submit).mockRejectedValue(new Error("connection lost"));
  vi.mocked(api.status).mockRejectedValue(new Error("Core unavailable"));
  await act(async () => root.render(<InstallDialog client={api} source={{ manifestPath: "app.json" }} onClose={() => {}} />));
  expect(container.textContent).toContain("Core may have received this request");
  expect(container.querySelector("a")).toBeNull();
  const retry = [...container.querySelectorAll("button")].find(button => button.textContent === "Check request status")!;
  await act(async () => retry.click());
  expect(api.prepare).toHaveBeenCalledTimes(1); expect(api.submit).toHaveBeenCalledTimes(1);
  vi.mocked(api.status).mockResolvedValue({ ...draft, status: "pending" });
  await act(async () => retry.click());
  expect(api.status).toHaveBeenLastCalledWith(draft.id);
  expect(container.querySelector("a")?.href).toBe(draft.approvalUrl);
  expect(container.textContent).not.toContain("connection lost");
});
it("offers a same-request retry after Core resolves an uncertain submit as a draft", async () => {
  const api = client();
  vi.mocked(api.submit).mockRejectedValueOnce(new Error("connection lost"));
  vi.mocked(api.status).mockRejectedValueOnce(new Error("Core unavailable"));
  await act(async () => root.render(<InstallDialog client={api} source={{ feedsUrl: "https://apps.example/feeds.json", feedId: "beta" }} onClose={() => {}} />));
  vi.mocked(api.status).mockResolvedValue(draft);
  await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Check request status")!.click());
  expect(container.textContent).toContain("Core has not received the submission.");
  vi.spyOn(window, "open").mockReturnValue(null);
  await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Retry")!.click());
  expect(api.prepare).toHaveBeenCalledTimes(1);
  expect(api.submit).toHaveBeenCalledTimes(2);
  expect(api.submit).toHaveBeenLastCalledWith(draft.id, undefined, undefined);
  expect(container.querySelector("a")?.href).toBe(draft.approvalUrl);
});
it("closes the reserved blank popup when Core refuses preparation", async () => {
  const api = client(); const confirmationWindow = popup();
  vi.mocked(api.prepare).mockRejectedValue(new Error("Authentication required"));
  await act(async () => root.render(<InstallDialog client={api} source={{ manifestPath: "app.json" }} confirmationWindow={confirmationWindow} onClose={() => {}} />));
  expect(confirmationWindow.close).toHaveBeenCalledOnce();
  expect(container.textContent).toContain("Authentication required");
  expect(api.submit).not.toHaveBeenCalled();
});
it("reports cancelled requests without retrying installation", async () => {
  const api = client(); vi.useFakeTimers();
  await act(async () => root.render(<InstallDialog client={api} source={{ manifestPath: "app.json" }} onClose={() => {}} />));
  vi.mocked(api.status).mockResolvedValue({ ...draft, status: "denied" });
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(container.textContent).toContain("Installation cancelled.");
  expect(container.querySelector("a")).toBeNull();
  expect(api.submit).toHaveBeenCalledTimes(1);
});
it("reports installation success once after Core's background operation finishes", async () => {
  const api = client(); const installed = vi.fn(); vi.useFakeTimers();
  await act(async () => root.render(<InstallDialog client={api} source={{ manifestPath: "app.json" }} onClose={() => {}} onInstalled={installed} />));
  vi.mocked(api.status).mockResolvedValue({ ...draft, status: "succeeded" });
  await act(async () => vi.advanceTimersByTimeAsync(4500));
  expect(installed).toHaveBeenCalledTimes(1);
  expect(installed.mock.calls[0][0].status).toBe("succeeded");
});

it("closes an unused reserved popup when navigation unmounts before preparation completes", async () => {
  const api = client(); const confirmationWindow = popup();
  let complete!: (request: InstallationRequest) => void;
  vi.mocked(api.prepare).mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  await act(async () => root.render(<InstallDialog client={api} source={{ manifestPath: "app.json" }} confirmationWindow={confirmationWindow} onClose={() => {}} />));
  await act(async () => root.render(null));
  expect(confirmationWindow.close).toHaveBeenCalledOnce();
  await act(async () => complete(draft));
  expect(api.submit).not.toHaveBeenCalled();
  expect(confirmationWindow.location.replace).not.toHaveBeenCalled();
});
it("closes the reservation when unmounted during submit without repeating that mutation", async () => {
  const api = client(); const confirmationWindow = popup();
  let complete!: (request: InstallationRequest) => void;
  vi.mocked(api.submit).mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  await act(async () => root.render(<InstallDialog client={api} source={{ manifestPath: "app.json" }} confirmationWindow={confirmationWindow} onClose={() => {}} />));
  await act(async () => root.render(null));
  expect(confirmationWindow.close).toHaveBeenCalledOnce();
  await act(async () => complete({ ...draft, status: "pending" }));
  expect(api.prepare).toHaveBeenCalledTimes(1); expect(api.submit).toHaveBeenCalledTimes(1);
  expect(confirmationWindow.location.replace).not.toHaveBeenCalled();
});
it("preserves the preopened window through StrictMode effect replay", async () => {
  const api = client(); const confirmationWindow = popup();
  await act(async () => root.render(<StrictMode><InstallDialog client={api} source={{ manifestPath: "app.json" }} confirmationWindow={confirmationWindow} onClose={() => {}} /></StrictMode>));
  expect(confirmationWindow.close).not.toHaveBeenCalled();
  expect(confirmationWindow.location.replace).toHaveBeenCalledExactlyOnceWith(draft.approvalUrl);
  expect(api.submit).toHaveBeenCalledTimes(1);
});
it("leaves an already visible Core confirmation open when the local progress UI unmounts", async () => {
  const confirmationWindow = popup();
  await act(async () => root.render(<InstallDialog client={client()} source={{ manifestPath: "app.json" }} confirmationWindow={confirmationWindow} onClose={() => {}} />));
  await act(async () => root.render(null));
  expect(confirmationWindow.close).not.toHaveBeenCalled();
});
it("lets a freshly selected channel adopt the same reserved window without old-session cleanup closing it", async () => {
  const api = client(); const confirmationWindow = popup();
  let completeOld!: (request: InstallationRequest) => void;
  vi.mocked(api.prepare).mockImplementationOnce(() => new Promise(resolve => { completeOld = resolve; }));
  const beta = { ...draft, id: "beta-request", approvalUrl: "https://core.example/install/confirm/beta" };
  vi.mocked(api.prepare).mockResolvedValueOnce(beta);
  vi.mocked(api.submit).mockResolvedValueOnce({ ...beta, status: "pending" });
  await act(async () => root.render(<InstallDialog client={api} source={{ feedsUrl: "https://apps.example/feeds.json", feedId: "stable" }} confirmationWindow={confirmationWindow} onClose={() => {}} />));
  await act(async () => root.render(<InstallDialog client={api} source={{ feedsUrl: "https://apps.example/feeds.json", feedId: "beta" }} confirmationWindow={confirmationWindow} onClose={() => {}} />));
  await act(async () => completeOld(draft));
  expect(confirmationWindow.close).not.toHaveBeenCalled();
  expect(confirmationWindow.location.replace).toHaveBeenCalledExactlyOnceWith(beta.approvalUrl);
  expect(api.submit).toHaveBeenCalledExactlyOnceWith(beta.id, undefined, undefined);
});
it("returns to the caller's source chooser after a known preparation error", async () => {
  const api = client(); const confirmationWindow = popup(); const chooseSource = vi.fn();
  vi.mocked(api.prepare).mockRejectedValue(new Error("Source connection required"));
  await act(async () => root.render(<InstallDialog client={api} source={{ manifestPath: "private.json" }} confirmationWindow={confirmationWindow} onChooseSource={chooseSource} onClose={() => {}} />));
  await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Change source")!.click());
  expect(confirmationWindow.close).toHaveBeenCalledOnce();
  expect(chooseSource).toHaveBeenCalledOnce();
  expect(api.submit).not.toHaveBeenCalled();
});
it("does not offer source changes while a submitted request remains uncertain", async () => {
  const api = client(); const chooseSource = vi.fn();
  vi.mocked(api.submit).mockRejectedValue(new TypeError("Network unavailable"));
  vi.mocked(api.status).mockRejectedValue(new TypeError("Network unavailable"));
  await act(async () => root.render(<InstallDialog client={api} source={{ manifestPath: "app.json" }} onChooseSource={chooseSource} onClose={() => {}} />));
  expect(container.textContent).toContain("Check request status");
  expect(container.textContent).not.toContain("Change source");
});
