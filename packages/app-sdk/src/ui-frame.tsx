"use client";
import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { UiHostContext } from "./ui-context";
import { appendThemeLaunchParams, parseActiveFrameAskAssistant, parseActiveFrameAttention, parseActiveFrameAuthRequired, parseActiveFramePermissionReview } from "./embedder";
import { createShellThemeMessage, type HostyResolvedTheme, type HostyThemePreference } from "./theme";
import { permissionReviewUrl } from "./permissions";
import type { UiFrameSurface } from "./ui-types";

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
  const { surface, title, className, standaloneHref, theme, themePreference } = props;
  const host = useContext(UiHostContext);
  const ref = useRef<HTMLIFrameElement>(null);
  const callbacks = useRef(props); callbacks.current = props;
  const [review, setReview] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [appearance, setAppearance] = useState<{ theme: HostyResolvedTheme; preference: HostyThemePreference }>({ theme: "light", preference: "system" });
  useEffect(() => {
    const read = () => { const root = document.documentElement; setAppearance({
      theme: root.classList.contains("dark") || root.dataset.hostyTheme === "dark" ? "dark" : "light",
      preference: root.dataset.hostyThemePreference === "dark" ? "dark" : root.dataset.hostyThemePreference === "light" ? "light" : "system" }); };
    read(); const observer = new MutationObserver(read); observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-hosty-theme", "data-hosty-theme-preference"] });
    return () => observer.disconnect();
  }, []);
  const resolvedTheme = theme ?? appearance.theme, preference = themePreference ?? appearance.preference;
  const source = props.src ?? new URL(surface.route, surface.origin).href;
  // Theme changes are messages; they must not replace a document with an unsent draft.
  const [launch] = useState(() => {
    const url = new URL(source); url.searchParams.set("hosty_launch", "embedded");
    return appendThemeLaunchParams(url.href, resolvedTheme, preference);
  });
  const frameId = JSON.stringify([surface, source]);
  useLayoutEffect(() => {
    const frame = ref.current; if (!frame || !host) return;
    return host.registerFrame(frame, surface);
  }, [host, frameId]); // Caller keys the frame by this immutable surface.
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
  useEffect(() => {
    if (loaded && props.outbound) ref.current?.contentWindow?.postMessage(props.outbound.message, surface.origin);
  }, [loaded, props.outbound?.nonce, surface.origin]);
  const insecure = typeof window !== "undefined" && window.location.protocol === "https:" && new URL(surface.origin).protocol === "http:";
  if (insecure) return <div role="status" className="hosty-panel-notice"><strong>{title} needs HTTPS to appear here</strong>
    <p>This app publishes an HTTP address. Configure its public HTTPS origin in Hosty.</p>
    {/^(localhost|127\.|\[::1\])/.test(new URL(surface.origin).hostname) && <p>This local address is reachable only from the Hosty computer.</p>}
    {standaloneHref && <a href={standaloneHref} target="_blank" rel="noopener noreferrer">Open separately</a>}
  </div>;
  return <>
    {review && <a className="hosty-panel-review" href={review} target="_blank" rel="noopener noreferrer">Review access in Core</a>}
    <iframe ref={ref} className={className} title={title} src={launch} sandbox={frameSandbox(surface.framePolicy)}
      allow={surface.framePolicy.microphone ? "clipboard-write; microphone 'src'" : "clipboard-write"}
      style={{ border: 0, height: "100%", width: "100%", colorScheme: resolvedTheme }} onLoad={() => setLoaded(true)} />
  </>;
}
