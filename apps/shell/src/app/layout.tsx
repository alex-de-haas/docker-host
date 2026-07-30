import type { Metadata } from "next";
import { Suspense } from "react";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { ShellClient } from "./shell-client";
import { getCoreOrigin, getShellAppId } from "./shell/server-env";

export const metadata: Metadata = {
  title: "Hosty Shell",
  description: "Hosty runtime app shell",
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon.ico", sizes: "any" },
    ],
    apple: "/apple-touch-icon.png",
  },
};

export const dynamic = "force-dynamic";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider>
          <Suspense fallback={<div className="min-h-dvh bg-muted/30" />}>
            <ShellClient coreOrigin={getCoreOrigin()} shellAppId={getShellAppId()}>
              {children}
            </ShellClient>
          </Suspense>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
