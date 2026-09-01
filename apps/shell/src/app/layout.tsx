import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Suspense } from "react";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { ShellClient } from "./shell-client";
import { getCoreOrigin, getShellAppId } from "./shell/server-env";
import { RIGHT_PANEL_OPEN_PREF_KEY, SIDEBAR_COMPACT_PREF_KEY } from "./shell/shell-routes";

// null means "no stored preference": the client then falls back to the legacy localStorage value
// once, instead of treating the absence as an explicit default.
function readChromePref(value: string | undefined): boolean | null {
  return value === "true" ? true : value === "false" ? false : null;
}

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

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const cookieStore = await cookies();
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider>
          <Suspense fallback={<div className="min-h-dvh bg-muted/30" />}>
            <ShellClient
              coreOrigin={getCoreOrigin()}
              shellAppId={getShellAppId()}
              initialSidebarCompact={readChromePref(cookieStore.get(SIDEBAR_COMPACT_PREF_KEY)?.value)}
              initialRightPanelOpen={readChromePref(cookieStore.get(RIGHT_PANEL_OPEN_PREF_KEY)?.value)}
            >
              {children}
            </ShellClient>
          </Suspense>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
