"use client";

import type { ReactNode } from "react";
import { HostyNextOverlay } from "@hosty-sdk/app/next";

export function DocumentsSession({ children }: { children: ReactNode }) {
  return <HostyNextOverlay>{children}</HostyNextOverlay>;
}
