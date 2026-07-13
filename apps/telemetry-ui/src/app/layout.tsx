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
  // Browser-reachable Core origin for client session recovery; falls back to the server origin.
  const corePublicOrigin =
    process.env.HOSTY_CORE_PUBLIC_ORIGIN || process.env.HOSTY_CORE_ORIGIN || "http://localhost:7070";
  const appId = process.env.HOSTY_APP_ID || "hosty.telemetry";
  return (
    <html lang="en">
      <body>
        <AppIdentityBridge corePublicOrigin={corePublicOrigin} appId={appId} />
        <HostThemeBridge />
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
