"use client";

import { HostyOverlay } from "@hosty-sdk/app/react";
import { PlansWorkbench } from "./workbench";

export function PlansSession() {
  return <HostyOverlay><PlansWorkbench /></HostyOverlay>;
}
