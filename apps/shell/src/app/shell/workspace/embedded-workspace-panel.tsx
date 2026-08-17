"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { ExternalLink, ShieldAlert } from "lucide-react";
import { DELEGATED_TOKEN_TYPE } from "@hosty-sdk/app";
import { parseActiveFrameDelegatedTokenRequest } from "@hosty-sdk/app/embedder";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { EmbeddedWorkspace, HostyResolvedTheme, HostyThemePreference } from "../types";
import { parseActiveFrameInstallFeedIntent, type InstallFeedIntent } from "./install-intent";
import { parseActiveFrameAuthRequired } from "./auth-intent";
import type { DelegatedTokenGrant } from "./delegated-token-intent";
import { getEmbedOrigin, isInsecureEmbedBlocked, isLoopbackEmbedHost } from "./insecure-embed";

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
  // Available to every app (recovery is universal); the panel verifies the sender before invoking it.
  onAuthRequired?: (appId: string) => void;
  // Mints a delegated token for this app. Undefined for every app but the assistant gateway, so no
  // listener is attached and a frame that asks is never answered — a delegated token is a
  // user-scoped credential, and handing one to whatever the operator installed is a different
  // decision from embedding it. `refresh` means the app's current token was refused, so a cached
  // mint must not be handed back.
  onDelegatedTokenRequest?: (refresh: boolean) => Promise<DelegatedTokenGrant>;
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

  useEffect(() => {
    if (!onAuthRequired) {
      return;
    }

    const handleMessage = (event: MessageEvent) => {
      const frameWindow = iframeRef.current?.contentWindow;
      if (parseActiveFrameAuthRequired(event, frameWindow, workspace.src, workspace.appId)) {
        onAuthRequired(workspace.appId);
      }
    };

    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, [onAuthRequired, workspace.src, workspace.appId]);

  // A layout effect, unlike every other listener here: the embedded page asks for its token from an
  // inline script, so the request can arrive as soon as the frame's document runs. Passive effects
  // flush after paint, which leaves a window where the only request would be dropped; layout effects
  // run in the same task as the DOM mutation that inserts the iframe, so the listener is attached
  // before the browser can dispatch anything from it. (The app half retries as well — an embedder
  // that attaches late is not something the app can verify.) The panel never renders on the server,
  // so there is no isomorphic-layout-effect problem to route around.
  useLayoutEffect(() => {
    if (!onDelegatedTokenRequest) {
      return;
    }

    const handleMessage = (event: MessageEvent) => {
      const frameWindow = iframeRef.current?.contentWindow;
      const intent = parseActiveFrameDelegatedTokenRequest(event, frameWindow, workspace.src);
      if (!intent) {
        return;
      }

      void (async () => {
        try {
          const grant = await onDelegatedTokenRequest(intent.refresh);
          // The token is a credential, so it goes to the frame's own origin — never "*" — and only
          // if that frame is still the one that asked: a mint is a round trip to Core, and the
          // panel may have navigated to another app in the meantime.
          if (iframeRef.current?.contentWindow !== frameWindow) {
            return;
          }
          frameWindow?.postMessage(
            { type: DELEGATED_TOKEN_TYPE, token: grant.token, expiresAt: grant.expiresAt },
            getPostMessageTargetOrigin(workspace.src),
          );
        } catch {
          // Staying silent is the honest answer: Shell has no surface here, and every reason a mint
          // fails (Core unreachable, the operator is not an administrator) is one the page states
          // better itself when its own request times out.
        }
      })();
    };

    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
    };
  }, [onDelegatedTokenRequest, workspace.src]);

  const handleLoad = useCallback(() => {
    setLoaded(true);
  }, []);

  const currentFrameLoaded = loaded && loadedSrc === workspace.src;

  // The page protocol is read through useSyncExternalStore so a server render stays
  // hydration-safe: the server snapshot reports "http:" (never blocked), and a normal client
  // mount reads the real protocol on its first render — no mounted-flag frame where the iframe
  // would briefly attempt the blocked load. The protocol is immutable for the page lifetime,
  // so the store never notifies.
  const pageProtocol = useSyncExternalStore(noopSubscribe, readPageProtocol, readServerPageProtocol);

  if (isInsecureEmbedBlocked(pageProtocol, workspace.src)) {
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

// Stable getters for useSyncExternalStore: the page protocol never changes within a page
// lifetime, so subscribe is a no-op and the snapshots are constants per environment.
const noopSubscribe = () => () => {};
const readPageProtocol = () => window.location.protocol;
const readServerPageProtocol = () => "http:";

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
