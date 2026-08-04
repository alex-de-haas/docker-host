import type { Metadata } from "next";
import type { ReactNode } from "react";
import { launchModeBootstrapScript } from "@hosty-sdk/app";
import { AppIdentityBridge, HostLaunchBridge } from "@hosty-sdk/app/react";
import { HostThemeBridge } from "@/components/host-theme-bridge";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hosty Marketplace",
  description: "Discover Hosty runtime apps from a configured catalog.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  // The identity bridge takes no props: recovery parameters come from the request-time identity
  // probe, never from a layout render that may be prerendered at image build time.
  return (
    // The bootstrap script sets `data-hosty-launch` on the root before hydration — an attribute the
    // server never rendered, which React would otherwise report as a hydration difference.
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Ahead of any body markup, so chrome a shell already renders is never painted. */}
        <script dangerouslySetInnerHTML={{ __html: launchModeBootstrapScript }} />
      </head>
      <body>
        <AppIdentityBridge />
        <HostThemeBridge />
        <HostLaunchBridge />
        {children}
      </body>
    </html>
  );
}
