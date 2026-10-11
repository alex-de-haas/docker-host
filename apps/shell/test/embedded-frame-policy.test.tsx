import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { EmbeddedAppFrame } from "../src/app/shell/embedding/embedded-app-frame";
import { createUiHost } from "@hosty-sdk/app/ui/host";
import { UiHostContext } from "../../../packages/app-sdk/src/ui-context";

type Policy = { microphone: boolean; popupEscape: boolean };
const metadata = vi.hoisted(() => ({ policy: undefined as Policy | undefined, launch: vi.fn() }));
vi.mock("../src/app/shell/shell-context", () => ({ useShellActions: () => ({ launchAppPage: metadata.launch }), useShellState: () => ({ state: { apps: [{
  id: "tool", entryEndpoint: "web", embeddedUrl: "https://tool.test/page", framePolicy: metadata.policy,
}] } }) }));
const both = ["providers.speech-to-text", "apps.install"];
it.each([false, true])("propagates the Shell navigation acceptance result: %s", async accepted => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); metadata.launch.mockReset().mockResolvedValue(accepted);
  const host = createUiHost({ active: false }), register = vi.spyOn(host, "registerFrame");
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<UiHostContext.Provider value={host}><EmbeddedAppFrame appId="tool"
      src="https://tool.test/page" title="Tool" theme="light" themePreference="light" /></UiHostContext.Provider>));
    const call = register.mock.calls.at(-1)!, navigate = call[3]!.navigate!;
    const result = navigate({ ...call[1], route: "/people" });
    if (accepted) await expect(result).resolves.toBeUndefined();
    else await expect(result).rejects.toMatchObject({ code: "navigation_unavailable" });
    expect(metadata.launch).toHaveBeenCalledWith(expect.objectContaining({ id: "tool" }),
      expect.objectContaining({ path: "/people", redirectUri: "https://tool.test/people" }));
  } finally { await act(async () => root.unmount()); host.dispose(); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); }
});
it("registers distinct stable views for simultaneous slots of the same app", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = createUiHost({ active: false }), register = vi.spyOn(host, "registerFrame");
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const show = (theme: "light" | "dark") => root.render(<UiHostContext.Provider value={host}>
    {["workspace", "settings", "panel"].map(slot => <EmbeddedAppFrame key={slot} appId="tool"
      src={`https://tool.test/${slot}`} title={slot} theme={theme} themePreference={theme} />)}
  </UiHostContext.Provider>);
  try {
    await act(async () => show("light"));
    const frames = [...container.querySelectorAll("iframe")];
    const ids = register.mock.calls.map(call => call[3]?.viewId);
    expect(frames).toHaveLength(3); expect(new Set(ids).size).toBe(3);
    await act(async () => show("dark"));
    expect([...container.querySelectorAll("iframe")]).toEqual(frames);
    expect(register.mock.calls.map(call => call[3]?.viewId)).toEqual(ids);
  } finally { await act(async () => root.unmount()); host.dispose(); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); }
});
const cases: [string, Policy | undefined, string[] | null | undefined, boolean, boolean][] = [
  ["missing grants", undefined, undefined, false, false],
  ["null grants", undefined, null, false, false],
  ["unrelated grants", undefined, ["providers.speech-to-text.other", "apps.install.other"], false, false],
  ["speech grant", undefined, ["providers.speech-to-text"], true, false],
  ["installation grant", undefined, ["apps.install"], false, true],
  ["both grants", undefined, both, true, true],
  ["explicit Core denial", { microphone: false, popupEscape: false }, both, false, false],
  ["explicit Core allowance", { microphone: true, popupEscape: true }, undefined, true, true],
];
it.each(cases)("renders frame capabilities from %s", async (_name, policy, grants, microphone, popupEscape) => {
  metadata.policy = policy;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<EmbeddedAppFrame appId="tool" src="https://tool.test/page" title="Tool"
      grantedCorePermissions={grants} theme="light" themePreference="system" />));
    const frame = container.querySelector("iframe")!;
    expect(frame.getAttribute("allow")!.includes("microphone 'src'")).toBe(microphone);
    expect(frame.getAttribute("sandbox")!.split(" ").includes("allow-popups-to-escape-sandbox")).toBe(popupEscape);
    expect(frame.getAttribute("sandbox")).not.toContain("allow-top-navigation");
  } finally {
    await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals();
  }
});
