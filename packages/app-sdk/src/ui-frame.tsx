"use client";
import { SdkChromeStyles } from "./sdk-chrome";
import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { UiHostContext } from "./ui-context";
import { appendThemeLaunchParams, parseActiveFrameAskAssistant, parseActiveFrameAttention, parseActiveFrameAuthRequired, parseActiveFramePermissionReview } from "./embedder";
import { createShellThemeMessage, type HostyResolvedTheme, type HostyThemePreference } from "./theme";
import { permissionReviewUrl } from "./permissions";
import { withChromeHints } from "./ui-composition";
import type { UiViewDescriptor } from "./ui-workspaces";
import type { UiFrameSurface } from "./ui-types";
import { createPresentationRequestId } from "./ui";

export function parseFrameMcpReview(event: { source: unknown; origin: string; data: unknown }, frame: unknown, src: string, appId: string) {
  if (!frame || event.source !== frame || !event.data || typeof event.data !== "object") return null;
  try { if (event.origin !== new URL(src).origin) return null; } catch { return null; }
  const data = event.data as Record<string, unknown>;
  return data.type === "hosty:request-mcp-review" && typeof data.targetAppId === "string" && /^[a-zA-Z0-9._:-]{1,128}$/.test(data.targetAppId)
    ? { appId, targetAppId: data.targetAppId } : null;
}

export function frameSandbox(policy: UiFrameSurface["framePolicy"]) {
  return "allow-scripts allow-same-origin allow-forms allow-popups allow-downloads" + (policy.popupEscape ? " allow-popups-to-escape-sandbox" : "");
}

export type HostyAppFrameProps = {
  view?: UiViewDescriptor;
  surface: UiFrameSurface; title: string; src?: string; className?: string;
  theme?: HostyResolvedTheme; themePreference?: HostyThemePreference;
  standaloneHref?: string | null;
  onAskAssistant?: (text: string, appId: string) => void;
  onAttention?: (count: number) => void; onAuthRequired?: (appId: string) => void;
  onMessage?: (event: MessageEvent, frame: Window | null) => void;
  outbound?: { message: unknown; nonce: number } | null;
};

/** Shared frame coordinator. No delegated-token responder and no authority inferred from messages. */
export function HostyAppFrame(props: HostyAppFrameProps) {
  const { title, className, standaloneHref, theme, themePreference } = props;
  const inputId = JSON.stringify([props.surface, props.src]);
  const [destination, setDestination] = useState<{ inputId: string; surface: UiFrameSurface } | null>(null);
  const surface = destination?.inputId === inputId ? destination.surface : props.surface;
  const [defaultViewId] = useState(createPresentationRequestId);
  const host = useContext(UiHostContext);
  const ref = useRef<HTMLIFrameElement>(null);
  const callbacks = useRef(props); callbacks.current = props;
  const [review, setReview] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [connection, setConnection] = useState({ ready: false, generation: 0 });
  const [appearance, setAppearance] = useState<{ theme: HostyResolvedTheme; preference: HostyThemePreference }>({ theme: "light", preference: "system" });
  useEffect(() => {
    const read = () => { const root = document.documentElement; setAppearance({
      theme: root.classList.contains("dark") || root.dataset.hostyTheme === "dark" ? "dark" : "light",
      preference: root.dataset.hostyThemePreference === "dark" ? "dark" : root.dataset.hostyThemePreference === "light" ? "light" : "system" }); };
    read(); const observer = new MutationObserver(read); observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-hosty-theme", "data-hosty-theme-preference"] });
    return () => observer.disconnect();
  }, []);
  const resolvedTheme = theme ?? appearance.theme, preference = themePreference ?? appearance.preference;
  const source = destination?.inputId === inputId ? new URL(surface.route, surface.origin).href
    : props.src ?? new URL(surface.route, surface.origin).href;
  // Theme changes are messages; they must not replace a document with an unsent draft.
  const [launch, setLaunch] = useState(() => {
    const url = new URL(source); url.searchParams.set("hosty_launch", "embedded");
    return appendThemeLaunchParams(withChromeHints(url.href, host?.getViewChrome?.(props.view?.viewId ?? defaultViewId)
      ?? props.view?.chrome ?? { navigation: "hide", tools: { launcher: "hide" } }), resolvedTheme, preference);
  });
  const frameId = JSON.stringify([surface, source]);
  useLayoutEffect(() => {
    const frame = ref.current; if (!frame || !host) return;
    const view = callbacks.current.view;
    return host.registerFrame(frame, surface, ready => setConnection(current => ({ ready, generation: current.generation + (ready ? 1 : 0) })),
      { viewId: defaultViewId, workspaceId: "default", chrome: { navigation: "hide", tools: { launcher: "hide" } }, ...view,
        navigate: next => {
          const current = callbacks.current;
          if (current.view?.navigate) return current.view.navigate(next);
          // Replace the document through React so every message handler follows its verified origin.
          const url = new URL(next.route, next.origin); url.searchParams.set("hosty_launch", "embedded");
          setLoaded(false); setReview(null);
          setDestination({ inputId: JSON.stringify([current.surface, current.src]), surface: { ...next, panelId: surface.panelId } });
          setLaunch(appendThemeLaunchParams(withChromeHints(url.href, host.getViewChrome(current.view?.viewId ?? defaultViewId)
            ?? current.view?.chrome ?? { navigation: "hide", tools: { launcher: "hide" } }), resolvedTheme, preference));
        } });
  }, [host, frameId]);
  const policy = JSON.stringify(props.view?.chrome ?? {});
  const previousPolicy = useRef({ viewId: props.view?.viewId, policy });
  useEffect(() => {
    const previous = previousPolicy.current; previousPolicy.current = { viewId: props.view?.viewId, policy };
    if (host && props.view && ref.current && previous.viewId === props.view.viewId && previous.policy !== policy)
      host.setViewChrome(props.view.viewId, JSON.parse(policy));
  }, [host, props.view?.viewId, policy]);
  useEffect(() => {
    if (loaded) ref.current?.contentWindow?.postMessage(createShellThemeMessage(resolvedTheme, preference), surface.origin);
  }, [loaded, resolvedTheme, preference, surface.origin]);
  useEffect(() => {
    const handle = (event: MessageEvent) => {
      const frame = ref.current?.contentWindow ?? null;
      if (!frame || event.source !== frame || event.origin !== surface.origin) return;
      const current = callbacks.current;
      if (parseActiveFrameAuthRequired(event, frame, source, surface.appId)) current.onAuthRequired?.(surface.appId);
      const ask = parseActiveFrameAskAssistant(event, frame, source); if (ask) current.onAskAssistant?.(ask.text, surface.appId);
      const attention = parseActiveFrameAttention(event, frame, source); if (attention !== null) current.onAttention?.(attention);
      const permission = parseActiveFramePermissionReview(event, frame, source, surface.appId);
      const mcp = parseFrameMcpReview(event, frame, source, surface.appId);
      const core = host?.getSnapshot().bootstrap?.coreOrigin;
      if (core && (permission || mcp)) {
        const url = mcp ? new URL(`/install/agents/${encodeURIComponent(mcp.appId)}/${encodeURIComponent(mcp.targetAppId)}`, core).href : permissionReviewUrl(core, surface.appId);
        setReview(url); window.open(url, "_blank", "noopener,noreferrer");
      }
      current.onMessage?.(event, frame);
    };
    window.addEventListener("message", handle); return () => window.removeEventListener("message", handle);
  }, [host, frameId, source, surface]);
  const outboundReady = host ? connection.ready : loaded;
  const sent = useRef<string | null>(null);
  useEffect(() => {
    if (outboundReady && props.outbound) {
      const key = `${connection.generation}:${props.outbound.nonce}`;
      if (sent.current === key) return;
      ref.current?.contentWindow?.postMessage(props.outbound.message, surface.origin); sent.current = key;
    }
  }, [outboundReady, connection.generation, props.outbound?.nonce, surface.origin]);
  const insecure = typeof window !== "undefined" && window.location.protocol === "https:" && new URL(surface.origin).protocol === "http:";
  if (insecure) return <div data-hosty-sdk role="status" className="hosty-panel-notice"><SdkChromeStyles /><strong>{title} needs HTTPS to appear here</strong>
    <p>This app publishes an HTTP address. Configure its public HTTPS origin in Hosty.</p>
    {/^(localhost|127\.|\[::1\])/.test(new URL(surface.origin).hostname) && <p>This local address is reachable only from the Hosty computer.</p>}
    {standaloneHref && <a href={standaloneHref} target="_blank" rel="noopener noreferrer">Open separately</a>}
  </div>;
  return <>
    {review && <><SdkChromeStyles /><a data-hosty-sdk className="hosty-panel-review" href={review} target="_blank" rel="noopener noreferrer">Review access in Core</a></>}
    <iframe ref={ref} className={className} title={title} src={launch} sandbox={frameSandbox(surface.framePolicy)}
      allow={surface.framePolicy.microphone ? "clipboard-write; display-capture 'src'; microphone 'src'" : "clipboard-write; display-capture 'src'"}
      style={{ border: 0, height: "100%", width: "100%", colorScheme: resolvedTheme }} onLoad={() => setLoaded(true)} />
  </>;
}
