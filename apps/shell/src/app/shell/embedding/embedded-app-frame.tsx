"use client";

import { HostyAppFrame } from "@hosty-sdk/app/ui/react";
import { useShellState, useShellActions } from "../shell-context";
import type { HostyResolvedTheme, HostyThemePreference } from "../types";
import type { DelegatedTokenGrant } from "../workspace/delegated-token-intent";

/** Shell supplies Core-projected identity; all frame coordination belongs to the SDK. */
export function EmbeddedAppFrame(props: {
  src: string; title: string; frameKey?: string; appId: string;
  standaloneHref?: string | null;
  grantedCorePermissions?: readonly string[] | null;
  theme: HostyResolvedTheme; themePreference: HostyThemePreference; className?: string;
  onAuthRequired?: (appId: string) => void;
  onDelegatedTokenRequest?: (refresh: boolean) => Promise<DelegatedTokenGrant>;
  onMessage?: (event: MessageEvent, frame: Window | null) => void;
  onAskAssistant?: (text: string, sourceAppId: string) => void;
  outbound?: { message: unknown; nonce: number } | null;
  onAttention?: (count: number) => void;
}) {
  const { state } = useShellState();
  const { launchAppPage } = useShellActions();
  const app = state.apps.find(item => item.id === props.appId);
  if (!app) return null;
  const url = new URL(props.src);
  for (const key of ["hosty_launch", "hosty_theme", "hosty_theme_preference", "hosty_navigation", "hosty_tools", "hosty_tool_launcher"]) url.searchParams.delete(key);
  const candidates = [...(app.navigation ?? []), ...(app.panelSurfaces ?? []), ...(app.settingsSurface ? [app.settingsSurface] : []),
    { endpoint: app.entryEndpoint, embeddedUrl: app.embeddedUrl }];
  const endpoint = candidates.find(item => item.embeddedUrl && new URL(item.embeddedUrl).origin === url.origin)?.endpoint ?? app.entryEndpoint;
  const surface = { appId: app.id, installationId: app.installationId ?? "", endpoint: endpoint ?? "",
    origin: url.origin, route: url.pathname + url.search + url.hash,
    framePolicy: app.framePolicy ?? {
      microphone: props.grantedCorePermissions?.includes("providers.speech-to-text") ?? false,
      popupEscape: props.grantedCorePermissions?.includes("apps.install") ?? false,
    } };
  return <HostyAppFrame key={JSON.stringify([props.frameKey, props.src, surface])} {...props} surface={surface}
    view={{ viewId: `app-${app.id}`, workspaceId: "default", chrome: { navigation: "hide", tools: { enabled: true, launcher: "hide" } },
      navigate: async next => {
        const page = app.navigation?.find(item => item.endpoint === next.endpoint && item.path === next.route);
        await launchAppPage(app, { label: page?.label ?? props.title, path: next.route,
          redirectUri: new URL(next.route, next.origin).href, service: page?.service });
      } }} />;
}
