import type { Metadata } from "next";
import { launchModeBootstrapScript, chromeBootstrapScript } from "@hosty-sdk/app";
import { HostLaunchBridge, HostThemeBridge } from "@hosty-sdk/app/react";
import { themeBootstrapScript } from "@hosty-sdk/app/theme";
import "./globals.css";
import { DemoSession } from "@/components/DemoSession";
import { DemoOverlay } from "@/components/DemoOverlay";

export const metadata: Metadata = {
  title: "Hosty Demo App",
  description: "A small Next.js runtime app for Hosty lifecycle testing.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Ahead of any body markup, so chrome a shell already renders is never painted, and the
            first paint is already in the shell's theme. */}
        <script dangerouslySetInnerHTML={{ __html: chromeBootstrapScript() }} /><script dangerouslySetInnerHTML={{ __html: launchModeBootstrapScript }} />
        <script dangerouslySetInnerHTML={{ __html: themeBootstrapScript }} />
      </head>
      <body className="font-sans antialiased">
        <HostThemeBridge />
        <HostLaunchBridge />
        <DemoOverlay><DemoSession>{children}</DemoSession></DemoOverlay>
      </body>
    </html>
  );
}
