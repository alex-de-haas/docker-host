import type { Metadata } from "next";
import { launchModeBootstrapScript } from "@hosty-sdk/app";
import { AppIdentityBridge, HostLaunchBridge, HostThemeBridge } from "@hosty-sdk/app/react";
import { themeBootstrapScript } from "@hosty-sdk/app/theme";
import "./globals.css";

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
        <script dangerouslySetInnerHTML={{ __html: launchModeBootstrapScript }} />
        <script dangerouslySetInnerHTML={{ __html: themeBootstrapScript }} />
      </head>
      <body className="font-sans antialiased">
        <HostThemeBridge />
        <HostLaunchBridge />
        <AppIdentityBridge />
        {children}
      </body>
    </html>
  );
}
