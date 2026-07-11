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
  return (
    <html lang="en">
      <body>
        <AppIdentityBridge />
        <HostThemeBridge />
        {children}
      </body>
    </html>
  );
}
