import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Docker Host Demo Module",
  description: "A small Next.js module for Docker Host lifecycle testing.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
