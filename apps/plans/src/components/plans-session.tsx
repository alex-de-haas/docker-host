"use client";

import { HostyNextOverlay as HostyOverlay } from "@hosty-sdk/app/next";
import { PlansWorkbench } from "./workbench";

export function PlansSession() {
  return <HostyOverlay><PlansWorkbench /></HostyOverlay>;
}
