import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { EmbeddedAppFrame } from "../src/app/shell/embedding/embedded-app-frame";

type Policy = { microphone: boolean; popupEscape: boolean };
const metadata = vi.hoisted(() => ({ policy: undefined as Policy | undefined }));
vi.mock("../src/app/shell/shell-context", () => ({ useShellState: () => ({ state: { apps: [{
  id: "tool", entryEndpoint: "web", embeddedUrl: "https://tool.test/page", framePolicy: metadata.policy,
}] } }) }));
const both = ["providers.speech-to-text", "apps.install"];
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
