import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Docker Host Manager",
  description: "Manage installed Docker Host modules",
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
