import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";
import { useAssistantSelection } from "../src/app/shell/assistant/use-assistant-selection";
import type { CoreApp } from "../src/app/shell/types";

const app = (id: string) => ({ id, displayName: id, runtimeState: "running", confirmedRoles: ["assistant"],
  version: "1.0.0", kind: "runtime", system: false, source: "test", operationStatus: "installed", capabilities: [],
  interfaces: { "ai-gateway": [{ key: "default", path: "/api", url: `http://${id}/api` }] } }) as CoreApp;
let host: HTMLDivElement, root: Root;
let delivered: Array<string | null>;
function Fixture({ apps, scope = "test-user" }: { apps: CoreApp[]; scope?: string }) {
  const selection = useAssistantSelection(apps, scope);
  return <><output>{selection.selected?.appId ?? "Choose"}</output>
    <button onClick={() => void selection.choose().then(app => delivered.push(app?.appId ?? null))}>Request</button>
    {selection.picker}</>;
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  for (const cookie of document.cookie.split("; ")) document.cookie = `${cookie.split("=")[0]}=; max-age=0; path=/`;
  delivered = []; host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(() => root.unmount()); host.remove(); });
async function render(apps: CoreApp[], scope?: string) { await act(() => root.render(<Fixture apps={apps} scope={scope} />)); }
async function click(text: string) {
  const button = [...document.querySelectorAll("button")].find(item => item.textContent === text)!;
  expect(button).toBeTruthy(); await act(async () => button.click());
}
test("request chooses explicitly, persists choice, and asks again after selected app disappears", async () => {
  await render([app("first"), app("second")]);
  expect(host.querySelector("output")!.textContent).toBe("Choose");
  await click("Request"); expect(delivered).toEqual([]);
  await click("second"); expect(delivered).toEqual(["second"]);
  await render([app("first")]);
  expect(host.querySelector("output")!.textContent).toBe("Choose");
  await click("Request"); expect(delivered).toEqual(["second"]);
  await click("first"); expect(delivered).toEqual(["second", "first"]);
  expect(document.cookie).toContain("hosty.shell.assistant.test-user=first");
});
test("changing the acting user cancels a pending choice and does not inherit their preference", async () => {
  await render([app("first"), app("second")]);
  await click("Request");
  await render([app("first"), app("second")], "another-user");
  expect(delivered).toEqual([null]);
  expect(host.querySelector("output")!.textContent).toBe("Choose");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
