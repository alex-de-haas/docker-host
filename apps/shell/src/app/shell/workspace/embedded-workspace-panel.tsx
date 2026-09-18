"use client";

import type { EmbeddedWorkspace, HostyResolvedTheme, HostyThemePreference } from "../types";
import { EmbeddedAppFrame } from "../embedding/embedded-app-frame";
import type { DelegatedTokenGrant } from "./delegated-token-intent";

// The workspace's embedding of an app page. Everything about *being* an embedder — the theme post,
// auth recovery, the delegated-token handshake, mixed-content blocking — lives in EmbeddedAppFrame,
// which Settings tabs and panel tabs use too. Installation stays in the app that initiates it.
export function EmbeddedWorkspacePanel({
  workspace,
  theme,
  themePreference,
  onAuthRequired,
  onAskAssistant,
  onDelegatedTokenRequest,
}: {
  workspace: EmbeddedWorkspace;
  theme: HostyResolvedTheme;
  themePreference: HostyThemePreference;
  // Called when the embedded app reports its Hosty session expired and asks for a fresh launch code.
  onAuthRequired?: (appId: string) => void;
  onAskAssistant?: (text: string, sourceAppId: string) => void;
  // Mints a delegated token for this app. Undefined for every app but the assistant gateway.
  onDelegatedTokenRequest?: (refresh: boolean) => Promise<DelegatedTokenGrant>;
}) {
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
        onAskAssistant={onAskAssistant}
        onDelegatedTokenRequest={onDelegatedTokenRequest}
      />
    </div>
  );
}
