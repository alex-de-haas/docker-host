"use client";

import { useCallback } from "react";
import type { EmbeddedWorkspace, HostyResolvedTheme, HostyThemePreference } from "../types";
import { EmbeddedAppFrame } from "../embedding/embedded-app-frame";
import { parseActiveFrameInstallFeedIntent, type InstallFeedIntent } from "./install-intent";
import type { DelegatedTokenGrant } from "./delegated-token-intent";

// The workspace's embedding of an app page. Everything about *being* an embedder — the theme post,
// auth recovery, the delegated-token handshake, mixed-content blocking — lives in EmbeddedAppFrame,
// which Settings tabs and panel tabs use too. What stays here is what only the workspace does:
// accept install intents from the Marketplace.
export function EmbeddedWorkspacePanel({
  workspace,
  theme,
  themePreference,
  onInstallFeedIntent,
  onAuthRequired,
  onDelegatedTokenRequest,
}: {
  workspace: EmbeddedWorkspace;
  theme: HostyResolvedTheme;
  themePreference: HostyThemePreference;
  // Undefined for apps that may not request installs (every app except Marketplace); when absent no
  // message listener is attached, so a non-Marketplace frame cannot initiate an install intent.
  onInstallFeedIntent?: (intent: InstallFeedIntent) => void;
  // Called when the embedded app reports its Hosty session expired and asks for a fresh launch code.
  onAuthRequired?: (appId: string) => void;
  // Mints a delegated token for this app. Undefined for every app but the assistant gateway.
  onDelegatedTokenRequest?: (refresh: boolean) => Promise<DelegatedTokenGrant>;
}) {
  const handleMessage = useCallback(
    (event: MessageEvent, frameWindow: Window | null) => {
      if (!onInstallFeedIntent) {
        return;
      }

      const intent = parseActiveFrameInstallFeedIntent(event, frameWindow, workspace.src, workspace.appId);
      if (intent) {
        onInstallFeedIntent(intent);
      }
    },
    [onInstallFeedIntent, workspace.src, workspace.appId],
  );

  return (
    <div className="relative h-full w-full overflow-hidden bg-background">
      <EmbeddedAppFrame
        src={workspace.src}
        title={`${workspace.title}: ${workspace.pageLabel}`}
        frameKey={`${workspace.appId}:${workspace.path}:${workspace.src}`}
        appId={workspace.appId}
        theme={theme}
        themePreference={themePreference}
        onAuthRequired={onAuthRequired}
        onDelegatedTokenRequest={onDelegatedTokenRequest}
        onMessage={onInstallFeedIntent ? handleMessage : undefined}
      />
    </div>
  );
}
