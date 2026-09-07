import type { Metadata } from "next";
import { HostThemeBridge } from "@hosty-sdk/app/react";
import { themeBootstrapScript } from "@hosty-sdk/app/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: "Assistant settings",
  description: "Operator configuration for the Hosty assistant.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // `suppressHydrationWarning` because the theme lands on <html> before React hydrates: the
  // server-rendered markup is deliberately theme-less, and the class the bootstrap writes would
  // otherwise read as a hydration mismatch.
  return (
    <html lang="en" suppressHydrationWarning>
      {/*
        Both bootstraps run ahead of any body markup, which is where the rest of the fleet puts them
        and what makes "before the first paint" true rather than merely likely: a script at the top
        of <body> can lose that race, and the cost is the flash each one exists to prevent.
      */}
      <head>
        {/*
          Stamps the launch mode on <html>, so the page can drop its own outer padding while a shell
          supplies it (globals.css) without a flash of the standalone layout.

          The attribute and its values are the SDK's contract (`LAUNCH_MODE_ATTRIBUTE`), written out
          here rather than imported. That was once because this workspace carried no SDK dependency;
          it now does, for the theme slice below, so what keeps this inline is only that
          `launchModeBootstrapScript` also persists a declared mode for the tab — a behaviour change
          that belongs to its own commit. `hosty_launch` survives the launch-code strip, and the
          framed check covers a reload that lost the parameter.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(()=>{try{var m=new URLSearchParams(location.search).get("hosty_launch");` +
              `if(m!=="embedded"&&m!=="native"&&m!=="standalone")m=null;` +
              `if(!m){try{m=self!==top?"embedded":"standalone"}catch(e){m="embedded"}}` +
              `document.documentElement.setAttribute("data-hosty-launch",m)}catch(e){}})()`,
          }}
        />
        {/*
          The theme, from the SDK slice that owns the protocol: the `hosty_theme` launch parameters
          decide what this document paints with, the value stored for the tab carries it across
          navigation, and `hosty:shell-theme` covers a change made while the frame is up. The bridge
          in the body then persists it, cleans the parameters out of the URL, and follows later posts.
        */}
        <script dangerouslySetInnerHTML={{ __html: themeBootstrapScript }} />
      </head>
      <body className="bg-background text-foreground antialiased">
        <HostThemeBridge />
        {children}
      </body>
    </html>
  );
}
