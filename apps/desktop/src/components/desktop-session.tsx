"use client";
import { HostyNextOverlay } from "@hosty-sdk/app/next";
import { Desktop } from "./desktop";
export function DesktopSession(props: { appId: string; coreOrigin: string }) {
  return <HostyNextOverlay navigation={{ renderer: "custom" }} panelLayout="none" chrome={{ navigation: "hide", tools: { enabled: true, launcher: "hide" } }}>
    <Desktop {...props} />
  </HostyNextOverlay>;
}
