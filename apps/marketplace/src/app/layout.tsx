import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppIdentityBridge } from "@/components/app-identity-bridge";
import { HostThemeBridge } from "@/components/host-theme-bridge";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hosty Marketplace",
  description: "Discover Hosty runtime apps from a configured catalog.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  // Browser-reachable Core origin for client session recovery; falls back to the server origin.
  const corePublicOrigin =
    process.env.HOSTY_CORE_PUBLIC_ORIGIN || process.env.HOSTY_CORE_ORIGIN || "http://localhost:7070";
  const appId = process.env.HOSTY_APP_ID || "hosty.marketplace";
  return (
    <html lang="en">
      <body>
        <AppIdentityBridge corePublicOrigin={corePublicOrigin} appId={appId} />
        <HostThemeBridge />
        {children}
      </body>
    </html>
  );
}
