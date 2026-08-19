import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Assistant settings",
  description: "Operator configuration for the Hosty assistant.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // `suppressHydrationWarning` because the embedder posts a theme class onto <html> before React
  // hydrates: the server-rendered markup is deliberately theme-less, and the class that arrives
  // first would otherwise read as a hydration mismatch.
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="bg-background text-foreground antialiased">{children}</body>
    </html>
  );
}
