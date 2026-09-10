import type { Metadata } from "next";
import type { ReactNode } from "react";
import { launchModeBootstrapScript } from "@hosty-sdk/app";
import { HostLaunchBridge, HostThemeBridge } from "@hosty-sdk/app/react";
import { themeBootstrapScript } from "@hosty-sdk/app/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hosty Marketplace",
  description: "Discover Hosty runtime apps from a configured catalog.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // The bootstrap script sets `data-hosty-launch` on the root before hydration — an attribute the
    // server never rendered, which React would otherwise report as a hydration difference.
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Ahead of any body markup, so chrome a shell already renders is never painted, and the
            first paint is already in the shell's theme. */}
        <script dangerouslySetInnerHTML={{ __html: launchModeBootstrapScript }} />
        <script dangerouslySetInnerHTML={{ __html: themeBootstrapScript }} />
      </head>
      <body>
        <HostThemeBridge />
        <HostLaunchBridge />
        {children}
      </body>
    </html>
  );
}
