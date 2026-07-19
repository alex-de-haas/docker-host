import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppIdentityBridge } from "@hosty-sdk/app/react";
import { AppShell } from "@/components/app-shell";
import { HostThemeBridge } from "@/components/host-theme-bridge";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hosty Telemetry",
  description: "Metrics, structured logs, and traces for the Hosty runtime fleet.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  // The identity bridge takes no props: recovery parameters come from the request-time identity
  // probe, never from a layout render — this app's pages are prerendered at image build time,
  // where the HOSTY_* environment does not exist yet.
  return (
    <html lang="en">
      <body>
        <AppIdentityBridge />
        <HostThemeBridge />
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
