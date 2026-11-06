"use client";
import { HostyNextOverlay } from "@hosty-sdk/app/next";
import { HostyPanelWorkspace } from "@hosty-sdk/app/ui/react";
import { Desktop } from "./desktop";
export function DesktopSession(props: { appId: string; coreOrigin: string }) {
  return <HostyNextOverlay navigation={{ renderer: "custom" }} panelLayout="none" chrome={{ navigation: "hide", tools: { enabled: true, launcher: "hide" } }}>
    <HostyPanelWorkspace><Desktop {...props} /></HostyPanelWorkspace>
  </HostyNextOverlay>;
}
