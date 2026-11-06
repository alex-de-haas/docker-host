import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ThemeFavicon } from "../../../../shared/web/theme-favicon";
import "./globals.css";
export const metadata: Metadata = { title: "Hosty Desktop", description: "Your apps. Your space." };
export default function Layout({ children }: { children: ReactNode }) {
  return <html lang="en" suppressHydrationWarning><body><ThemeFavicon />{children}</body></html>;
}
