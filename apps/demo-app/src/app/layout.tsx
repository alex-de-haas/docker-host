import type { Metadata } from "next";
import { HostIdentityBridge } from "@/components/HostIdentityBridge";
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
    <html lang="en">
      <body className="font-sans antialiased">
        <HostIdentityBridge />
        {children}
      </body>
    </html>
  );
}
