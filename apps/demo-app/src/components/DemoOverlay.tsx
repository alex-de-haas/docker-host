"use client";
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { HostyNextOverlay } from "@hosty-sdk/app/next";

/** The conformance desktop supplies its own workspace slots. Ordinary Demo pages host no tools. */
export function DemoOverlay({ children }: { children: ReactNode }) {
  const desktop = usePathname() === "/composition";
  return <HostyNextOverlay navigation={{ renderer: "custom" }} panelLayout={desktop ? "slot" : "none"}
    chrome={{ tools: { enabled: desktop, launcher: desktop ? "show" : "hide" } }}>{children}</HostyNextOverlay>;
}
