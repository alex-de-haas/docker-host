import type { ReactNode } from "react";
import type { Metadata } from "next";
import { launchModeBootstrapScript } from "@hosty-sdk/app";
import { themeBootstrapScript } from "@hosty-sdk/app/theme";
import { HostLaunchBridge, HostThemeBridge } from "@hosty-sdk/app/react";
import "./globals.css";
export const metadata: Metadata = { title: "Hosty Workspaces", description: "Development workspaces and repository changes." };
export default function Layout({ children }: { children: ReactNode }) {
  return <html lang="en" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{ __html: launchModeBootstrapScript }} /><script dangerouslySetInnerHTML={{ __html: themeBootstrapScript }} /></head><body><HostThemeBridge /><HostLaunchBridge />{children}</body></html>;
}
