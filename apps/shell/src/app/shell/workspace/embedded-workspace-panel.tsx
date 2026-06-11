"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { EmbeddedWorkspace, HostyResolvedTheme, HostyThemePreference } from "../types";

export function EmbeddedWorkspacePanel({
  workspace,
  theme,
  themePreference,
}: {
  workspace: EmbeddedWorkspace;
  theme: HostyResolvedTheme;
  themePreference: HostyThemePreference;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadedSrc, setLoadedSrc] = useState(workspace.src);

  if (workspace.src !== loadedSrc) {
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

  const handleLoad = useCallback(() => {
    setLoaded(true);
  }, []);

  return (
    <div className="relative h-full w-full overflow-hidden bg-background">
      <iframe
        ref={iframeRef}
        key={`${workspace.appId}:${workspace.path}:${workspace.src}`}
        className={cn("hosty-app-frame transition-opacity duration-100", loaded ? "opacity-100" : "opacity-0")}
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
