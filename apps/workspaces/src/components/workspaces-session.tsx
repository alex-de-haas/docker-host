"use client";

import { HostyOverlay } from "@hosty-sdk/app/react";
import { WorkspacesWorkbench } from "./workbench";

export function WorkspacesSession() {
  return <HostyOverlay><WorkspacesWorkbench /></HostyOverlay>;
}
