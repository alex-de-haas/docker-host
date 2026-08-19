"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { ExternalLink, ShieldAlert } from "lucide-react";
import { DELEGATED_TOKEN_TYPE } from "@hosty-sdk/app";
import { parseActiveFrameDelegatedTokenRequest } from "@hosty-sdk/app/embedder";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { HostyResolvedTheme, HostyThemePreference } from "../types";
import { parseActiveFrameAuthRequired } from "../workspace/auth-intent";
import type { DelegatedTokenGrant } from "../workspace/delegated-token-intent";
import { getEmbedOrigin, isInsecureEmbedBlocked, isLoopbackEmbedHost } from "../workspace/insecure-embed";

// Every place Shell embeds an app's page. There are three now — the workspace, a Settings tab, and a
// right-panel tab (docs/features/app-ui-surfaces/plan.md) — and they share this one component rather
// than a copy each.
//
// That is the whole point of extracting it. The delegated-token handshake used to live only in the
// workspace, so a page embedded anywhere else hung waiting for an answer that no listener was going
// to give; the failure looked like a broken app, not like a missing embedder. A second copy would
// have been a second thing to forget.

export function EmbeddedAppFrame({
  src,
  title,
  frameKey,
  appId,
  theme,
  themePreference,
  className,
  onAuthRequired,
  onDelegatedTokenRequest,
  onMessage,
}: {
  src: string;
  title: string;
  /** Remounts the iframe when it changes, so a navigation is a fresh document rather than a reused one. */
  frameKey?: string;
  appId: string;
  theme: HostyResolvedTheme;
  themePreference: HostyThemePreference;
  className?: string;
  /** Called when the app reports its Hosty session expired. Recovery is universal, so every context passes it. */
  onAuthRequired?: (appId: string) => void;
  /**
   * Mints a delegated token for this app, or undefined to answer nothing.
   *
   * Undefined is a real answer, not an omission: a delegated token is a user-scoped credential, and
   * handing one to whatever the operator installed is a different decision from embedding it. A
   * context that passes nothing attaches no listener, so a frame that asks is simply never answered.
   */
  onDelegatedTokenRequest?: (refresh: boolean) => Promise<DelegatedTokenGrant>;
  /** Extra verified-sender message handling for one context (the Marketplace's install intents). */
  onMessage?: (event: MessageEvent, frameWindow: Window | null) => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadedSrc, setLoadedSrc] = useState(src);

  // Reset while rendering rather than in an effect: https://react.dev/learn/you-might-not-need-an-effect
  if (loadedSrc !== src) {
    setLoadedSrc(src);
    setLoaded(false);
  }

  const postTheme = useCallback(() => {
    const frame = iframeRef.current;
    if (!frame?.contentWindow) {
      return;
    }

    try {
      frame.contentWindow.postMessage(
        { type: "hosty:shell-theme", theme, preference: themePreference },
        getPostMessageTargetOrigin(src),
      );
    } catch {
      // A frame that has navigated away or is mid-teardown is not an error worth surfacing.
    }
  }, [src, theme, themePreference]);

  useEffect(() => {
    postTheme();
  }, [postTheme]);

  useEffect(() => {
    if (!onAuthRequired) {
      return;
    }

    const handleMessage = (event: MessageEvent) => {
      if (parseActiveFrameAuthRequired(event, iframeRef.current?.contentWindow, src, appId)) {
        onAuthRequired(appId);
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [onAuthRequired, src, appId]);

  useEffect(() => {
    if (!onMessage) {
      return;
    }

    const handleMessage = (event: MessageEvent) => onMessage(event, iframeRef.current?.contentWindow ?? null);
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [onMessage]);

  // A layout effect, unlike every other listener here: the embedded page asks for its token from an
  // inline script, so the request can arrive as soon as the frame's document runs. Passive effects
  // flush after paint, which leaves a window where the only request would be dropped; layout effects
  // run in the same task as the DOM mutation that inserts the iframe, so the listener is attached
  // before the browser can dispatch anything from it. (The app half retries as well — an embedder
  // that attaches late is not something the app can verify.)
  useLayoutEffect(() => {
    if (!onDelegatedTokenRequest) {
      return;
    }

    const handleMessage = (event: MessageEvent) => {
      const frameWindow = iframeRef.current?.contentWindow;
      const intent = parseActiveFrameDelegatedTokenRequest(event, frameWindow, src);
      if (!intent) {
        return;
      }

      void (async () => {
        try {
          const grant = await onDelegatedTokenRequest(intent.refresh);
          // The token is a credential, so it goes to the frame's own origin — never "*" — and only
          // if that frame is still the one that asked: a mint is a round trip to Core, and the
          // context may have navigated to another app in the meantime.
          if (iframeRef.current?.contentWindow !== frameWindow) {
            return;
          }
          frameWindow?.postMessage(
            { type: DELEGATED_TOKEN_TYPE, token: grant.token, expiresAt: grant.expiresAt },
            getPostMessageTargetOrigin(src),
          );
        } catch {
          // Staying silent is the honest answer: Shell has no surface here, and every reason a mint
          // fails (Core unreachable, the operator is not an administrator) is one the page states
          // better itself when its own request times out.
        }
      })();
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [onDelegatedTokenRequest, src]);

  const handleLoad = useCallback(() => setLoaded(true), []);
  const currentFrameLoaded = loaded && loadedSrc === src;

  // Read through useSyncExternalStore so a server render stays hydration-safe: the server snapshot
  // reports "http:" (never blocked), and a client mount reads the real protocol on its first render.
  const pageProtocol = useSyncExternalStore(noopSubscribe, readPageProtocol, readServerPageProtocol);
  if (isInsecureEmbedBlocked(pageProtocol, src)) {
    return <BlockedInsecureEmbed src={src} title={title} />;
  }

  return (
    <iframe
      ref={iframeRef}
      key={frameKey ?? src}
      className={cn("hosty-app-frame transition-opacity duration-100", currentFrameLoaded ? "opacity-100" : "opacity-0", className)}
      title={title}
      src={src}
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
      allow="clipboard-write"
      style={{ colorScheme: theme }}
      onLoad={handleLoad}
    />
  );
}

const noopSubscribe = () => () => {};
const readPageProtocol = () => window.location.protocol;
const readServerPageProtocol = () => "http:";

// Rendered instead of the iframe when embedding is impossible (https Shell, http app URL). The
// browser would block the frame as mixed content without firing load or error, leaving a blank panel
// with no hint at the cause — this states the cause and the fix.
function BlockedInsecureEmbed({ src, title }: { src: string; title: string }) {
  const origin = getEmbedOrigin(src);
  return (
    <div className="flex h-full w-full items-center justify-center bg-background px-6">
      <div className="max-w-lg rounded-lg border bg-card p-6 text-center">
        <ShieldAlert className="mx-auto mb-3 h-6 w-6 text-amber-600" />
        <div className="font-medium">{title} can&apos;t be embedded over HTTPS</div>
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
          <a href={src} target="_blank" rel="noreferrer">
            <ExternalLink /> Open in a new tab
          </a>
        </Button>
        {isLoopbackEmbedHost(src) && (
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
