"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { EmbeddedWorkspace, HostyResolvedTheme, HostyThemePreference } from "../types";
import { parseActiveFrameInstallFeedIntent, type InstallFeedIntent } from "./install-intent";
import { getEmbedOrigin, isInsecureEmbedBlocked, isLoopbackEmbedHost } from "./insecure-embed";

export function EmbeddedWorkspacePanel({
  workspace,
  theme,
  themePreference,
  onInstallFeedIntent,
}: {
  workspace: EmbeddedWorkspace;
  theme: HostyResolvedTheme;
  themePreference: HostyThemePreference;
  // Undefined for apps that may not request installs (every app except Marketplace); when absent no
  // message listener is attached, so a non-Marketplace frame cannot initiate an install intent.
  onInstallFeedIntent?: (intent: InstallFeedIntent) => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadedSrc, setLoadedSrc] = useState(workspace.src);

  // Reset the loaded flag while rendering when the iframe source changes, instead
  // of in an effect. https://react.dev/learn/you-might-not-need-an-effect
  if (loadedSrc !== workspace.src) {
    setLoadedSrc(workspace.src);
    setLoaded(false);
  }

  const postTheme = useCallback(() => {
    const frame = iframeRef.current;
    if (!frame?.contentWindow) {
      return;
    }

    try {
      frame.contentWindow.postMessage(
        {
          type: "hosty:shell-theme",
          theme,
          preference: themePreference,
        },
        getPostMessageTargetOrigin(workspace.src),
      );
    } catch {
      // The frame can still be about:blank or chrome-error while a local app is restarting.
    }
  }, [theme, themePreference, workspace.src]);

  useEffect(() => {
    if (loaded) {
      postTheme();
    }
  }, [loaded, postTheme]);

  useEffect(() => {
    if (!onInstallFeedIntent) {
      return;
    }

    const handleMessage = (event: MessageEvent) => {
      const frameWindow = iframeRef.current?.contentWindow;
      const intent = parseActiveFrameInstallFeedIntent(event, frameWindow, workspace.src);
      if (intent) {
        onInstallFeedIntent(intent);
      }
    };

    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, [onInstallFeedIntent, workspace.src]);

  const handleLoad = useCallback(() => {
    setLoaded(true);
  }, []);

  const currentFrameLoaded = loaded && loadedSrc === workspace.src;

  // Checked after the hooks so the hook order stays stable when the src flips between blocked
  // and embeddable (e.g. the operator sets a public origin and the app restarts).
  if (typeof window !== "undefined" && isInsecureEmbedBlocked(window.location.protocol, workspace.src)) {
    return <BlockedInsecureEmbedPanel workspace={workspace} />;
  }

  return (
    <div className="relative h-full w-full overflow-hidden bg-background">
      <iframe
        ref={iframeRef}
        key={`${workspace.appId}:${workspace.path}:${workspace.src}`}
        className={cn("hosty-app-frame transition-opacity duration-100", currentFrameLoaded ? "opacity-100" : "opacity-0")}
        title={`${workspace.title}: ${workspace.pageLabel}`}
        src={workspace.src}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
        allow="clipboard-write"
        style={{ colorScheme: theme }}
        onLoad={handleLoad}
      />
    </div>
  );
}

// Rendered instead of the iframe when embedding is impossible (https Shell, http app URL). The
// browser would block the frame as mixed content without firing load or error, leaving a blank
// panel with no hint at the cause — this states the cause and the fix. Opening in a new tab stays
// available because top-level navigation is not subject to mixed-content blocking.
function BlockedInsecureEmbedPanel({ workspace }: { workspace: EmbeddedWorkspace }) {
  const origin = getEmbedOrigin(workspace.src);
  return (
    <div className="flex h-full w-full items-center justify-center bg-background px-6">
      <div className="max-w-lg rounded-lg border bg-card p-6 text-center">
        <ShieldAlert className="mx-auto mb-3 h-6 w-6 text-amber-600" />
        <div className="font-medium">{workspace.title} can&apos;t be embedded over HTTPS</div>
        <p className="mt-2 text-sm text-muted-foreground">
          Shell is open at an https:// address, but this app publishes its UI at{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">{origin}</code> — plain http. Browsers
          refuse to embed insecure content in a secure page, so the frame would stay blank.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          Give the app a public HTTPS origin: set its <code className="rounded bg-muted px-1 py-0.5 text-xs">HOSTY_PUBLIC_ORIGIN_…</code>{" "}
          app setting, or enable managed ingress so Core derives one, then restart the app.
        </p>
        <Button asChild variant="outline" size="sm" className="mt-4">
          <a href={workspace.externalUrl} target="_blank" rel="noreferrer">
            <ExternalLink /> Open in a new tab
          </a>
        </Button>
        {isLoopbackEmbedHost(workspace.src) && (
          <p className="mt-3 text-xs text-muted-foreground">
            {origin} is a loopback address, so it is only reachable from a browser running on the Hosty
            host itself.
          </p>
        )}
      </div>
    </div>
  );
}

function getPostMessageTargetOrigin(src: string) {
  try {
    return new URL(src, window.location.origin).origin;
  } catch {
    return window.location.origin;
  }
}
