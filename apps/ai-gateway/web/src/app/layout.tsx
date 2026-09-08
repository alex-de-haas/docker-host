import type { Metadata } from "next";
import { launchModeBootstrapScript } from "@hosty-sdk/app";
import { HostLaunchBridge, HostThemeBridge } from "@hosty-sdk/app/react";
import { themeBootstrapScript } from "@hosty-sdk/app/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: "Assistant settings",
  description: "Operator configuration for the Hosty assistant.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // `suppressHydrationWarning` because the theme lands on <html> before React hydrates: the
  // server-rendered markup is deliberately theme-less, and the class the bootstrap writes would
  // otherwise read as a hydration mismatch.
  return (
    <html lang="en" suppressHydrationWarning>
      {/*
        Both bootstraps run ahead of any body markup, which is where the rest of the fleet puts them
        and what makes "before the first paint" true rather than merely likely: a script at the top
        of <body> can lose that race, and the cost is the flash each one exists to prevent.
      */}
      <head>
        {/*
          The launch mode, so the page drops the chrome and the outer padding a shell already
          supplies (globals.css) without a flash of the standalone layout. This was a hand-written
          copy of the SDK's contract while the workspace carried no SDK dependency; it now carries
          one, and a second implementation of a protocol is what this fleet keeps paying for.
        */}
        <script dangerouslySetInnerHTML={{ __html: launchModeBootstrapScript }} />
        {/*
          The theme, from the SDK slice that owns the protocol: the `hosty_theme` launch parameters
          decide what this document paints with, the value stored for the tab carries it across
          navigation, and `hosty:shell-theme` covers a change made while the frame is up.
        */}
        <script dangerouslySetInnerHTML={{ __html: themeBootstrapScript }} />
      </head>
      <body className="bg-background text-foreground antialiased">
        {/*
          The bridges own what a paint-blocking script must not do: persisting what a shell declared
          for the rest of the tab, and cleaning its parameters out of the URL — a `replaceState` is
          a router's business, and a copied link must not carry a shell's presentation into a plain
          browser tab.
        */}
        <HostLaunchBridge />
        <HostThemeBridge />
        {children}
      </body>
    </html>
  );
}
