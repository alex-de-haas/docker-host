import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Docker Host Manager",
  description: "Manage installed Docker Host modules",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
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
