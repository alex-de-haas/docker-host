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
      <body className="bg-background text-foreground antialiased">
        {/*
          Stamps the launch mode on <html> before the first paint, so the page can drop its own outer
          padding while a shell supplies it (globals.css) without a flash of the standalone layout.

          The attribute and its values are the SDK's contract (`LAUNCH_MODE_ATTRIBUTE`), written out
          here rather than imported: this workspace deliberately carries no SDK dependency, and its
          install path has already needed two fixes. `hosty_launch` survives the launch-code strip,
          and the framed check covers a reload that lost the parameter.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(()=>{try{var m=new URLSearchParams(location.search).get("hosty_launch");` +
              `if(m!=="embedded"&&m!=="native"&&m!=="standalone")m=null;` +
              `if(!m){try{m=self!==top?"embedded":"standalone"}catch(e){m="embedded"}}` +
              `document.documentElement.setAttribute("data-hosty-launch",m)}catch(e){}})()`,
          }}
        />
        {children}
      </body>
    </html>
  );
}
