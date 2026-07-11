"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { EmbeddedWorkspace, HostyResolvedTheme, HostyThemePreference } from "../types";
import { parseActiveFrameInstallFeedIntent, type InstallFeedIntent } from "./install-intent";

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

function getPostMessageTargetOrigin(src: string) {
  try {
    return new URL(src, window.location.origin).origin;
  } catch {
    return window.location.origin;
  }
}
