import type { Metadata } from "next";
import { AppIdentityBridge } from "@hosty-sdk/app/react";
import { HostThemeBridge } from "@/components/HostThemeBridge";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hosty Demo App",
  description: "A small Next.js runtime app for Hosty lifecycle testing.",
};

const hostThemeBootstrapScript = `
(() => {
  try {
    const params = new URLSearchParams(window.location.search);
    const queryTheme = params.get("hosty_theme");
    const storedTheme = window.sessionStorage.getItem("hosty.theme.resolved");
    const theme = queryTheme === "dark" || queryTheme === "light"
      ? queryTheme
      : storedTheme === "dark" || storedTheme === "light"
        ? storedTheme
        : window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
    const root = document.documentElement;
    root.classList.toggle("dark", theme === "dark");
    root.style.colorScheme = theme;
    root.dataset.hostyTheme = theme;
  } catch {}
})();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="font-sans antialiased">
        <script dangerouslySetInnerHTML={{ __html: hostThemeBootstrapScript }} />
        <HostThemeBridge />
        <AppIdentityBridge />
        {children}
      </body>
    </html>
  );
}
