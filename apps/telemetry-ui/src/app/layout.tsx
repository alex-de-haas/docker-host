import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppIdentityBridge } from "@/components/app-identity-bridge";
import { AppShell } from "@/components/app-shell";
import { HostThemeBridge } from "@/components/host-theme-bridge";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hosty Telemetry",
  description: "Metrics, structured logs, and traces for the Hosty runtime fleet.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
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
