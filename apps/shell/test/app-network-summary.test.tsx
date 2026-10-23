import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppNetworkSummary } from "../src/app/shell/pages/app-network-summary";
import type { CoreApp } from "../src/app/shell/types";

vi.mock("../src/app/shell/pages/port-reassign-control", () => ({
  EndpointAvailabilityMarker: ({ availability }: { availability?: string }) => availability === "unavailable" ? <span>Reserved port unavailable</span> : null,
  PortReassignControl: ({ endpoint }: { endpoint: { key: string } }) => <button type="button" data-reassign={endpoint.key}>Existing reassignment control</button>,
}));
vi.mock("../src/app/shell/pages/public-origin-control", () => ({
  PublicOriginControl: ({ endpoint }: { endpoint: { key: string } }) => <button type="button" data-public-origin={endpoint.key}>Existing public address control</button>,
}));
vi.mock("../src/components/reui/operation-toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
let root: Root, container: HTMLDivElement;
const app: CoreApp = { id: "example.media", displayName: "Media", version: "1.0.0", kind: "runtime", system: false,
  source: "manifest", operationStatus: "started", runtimeState: "running", capabilities: [],
  endpoints: [
    { key: "ui", service: "web", port: "http", protocol: "http", public: true, url: "http://127.0.0.1:9000", browserOrigin: "http://media.hosty.localhost:9000", localOrigin: "http://media.hosty.localhost:9000" },
    { key: "database", service: "db", port: "postgres", protocol: "tcp", public: false, url: "tcp://127.0.0.1:5432", availability: "unavailable" },
  ] };
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it("keeps actual endpoint addresses and existing controls without offering an unsupported internal publication", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined); vi.stubGlobal("navigator", { clipboard: { writeText } });
  await act(async () => root.render(<AppNetworkSummary app={app} />));
  expect(container.querySelectorAll('[data-reassign]')).toHaveLength(2);
  expect([...container.querySelectorAll('[data-public-origin]')].map(item => item.getAttribute("data-public-origin"))).toEqual(["ui"]);
  expect(container.textContent).toContain("Reserved port unavailable");
  expect(container.textContent).toContain("Internal endpoint");
  expect(container.textContent).toContain("this computer only");
  expect([...container.querySelectorAll('a')].map(item => item.href)).toEqual(["http://127.0.0.1:9000/", "http://media.hosty.localhost:9000/", "tcp://127.0.0.1:5432"]);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Copy browser address"]')!.click());
  expect(writeText).toHaveBeenCalledExactlyOnceWith("http://media.hosty.localhost:9000");
});

it("keeps missing addresses explicit and does not fabricate links or clipboard actions", async () => {
  await act(async () => root.render(<AppNetworkSummary app={{ ...app, endpoints: [{ key: "ui", protocol: "http", public: true }] }} />));
  expect(container.textContent).toContain("Not assigned"); expect(container.textContent).toContain("Not configured");
  expect(container.querySelector('a')).toBeNull();
  expect(container.querySelector('[aria-label^="Copy"]')).toBeNull();
  expect(container.querySelector('[data-public-origin="ui"]')).not.toBeNull();
});
