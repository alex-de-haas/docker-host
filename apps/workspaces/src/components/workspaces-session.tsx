"use client";

import { HostyNextOverlay as HostyOverlay } from "@hosty-sdk/app/next";
import { WorkspacesWorkbench } from "./workbench";

export function WorkspacesSession() {
  return <HostyOverlay><WorkspacesWorkbench /></HostyOverlay>;
}
