"use client";

import { HostyNextOverlay as HostyOverlay } from "@hosty-sdk/app/next";
import { DocumentsWorkbench } from "./workbench";

export function DocumentsSession() {
  return (
    <HostyOverlay navigation={{ renderer: "custom" }}>
      <DocumentsWorkbench />
    </HostyOverlay>
  );
}
