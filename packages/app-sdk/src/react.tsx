"use client";

// React slice: the client identity bridge — probe, silent recovery, and the fallback
// cards. Prop-less by design: the app id and browser-reachable Core origin arrive in the
// probe response's `recovery` field (request-time values, never build-time props).

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  buildCoreOpenUrl,
  decideRecoveryAction,
  detectLaunchMode,
  normalizeLaunchMode,
  readRecoveryParams,
  resolveLaunchMode,
  LAUNCH_MODE_ATTRIBUTE,
  LAUNCH_MODE_PARAM,
  LAUNCH_MODE_STORAGE_KEY,
  type AppLaunchMode,
  type AppSessionStatus,
  type RecoveryAction,
} from "./index";
import {
  applyTheme,
  parseShellThemeMessage,
  resolveTheme,
  THEME_PARAM,
  THEME_PREFERENCE_PARAM,
  THEME_PREFERENCE_STORAGE_KEY,
  THEME_STORAGE_KEY,
  type HostyResolvedTheme,
  type HostyThemePreference,
} from "./theme";

// Once-per-tab guard so a standalone app that returns from Core still unauthorized does
// not bounce through /open forever. Cleared on a successful code exchange.
const RECOVERY_GUARD_KEY = "hosty.auth.recovery-attempted";
// How long an embedded frame waits for the Shell to reissue a launch code before showing
// the manual sign-in fallback (i.e. it is embedded by something other than Hosty Shell).
const EMBEDDED_RECOVERY_TIMEOUT_MS = 4_000;
// Cap the status probe so a stalled request cannot leave the bridge stuck hidden — on
// timeout it classifies as unavailable and the user gets a Retry affordance.
const IDENTITY_PROBE_TIMEOUT_MS = 4_000;

const KNOWN_STATUSES: readonly AppSessionStatus[] = [
  "not-present",
  "active",
  "expired",
  "forbidden",
  "unavailable",
  "misconfigured",
];

/**
 * Tolerant probe reader: accepts both identity-route shapes in the fleet — a top-level
 * `status` (marketplace/telemetry) and a nested `appSession.status` (demo-app,
 * project-manager). The legacy `error` status maps to `unavailable` (transient).
 */
export function readProbedSessionStatus(body: unknown): AppSessionStatus | null {
  if (!body || typeof body !== "object") {
    return null;
  }
  const record = body as { status?: unknown; appSession?: unknown };
  const nested =
    record.appSession && typeof record.appSession === "object"
      ? (record.appSession as { status?: unknown }).status
      : undefined;
  const raw = typeof record.status === "string" ? record.status : nested;
  if (typeof raw !== "string") {
    return null;
  }
  if (raw === "error") {
    return "unavailable";
  }
  return (KNOWN_STATUSES as readonly string[]).includes(raw) ? (raw as AppSessionStatus) : null;
}

function readGuard(): boolean {
  try {
    return window.sessionStorage.getItem(RECOVERY_GUARD_KEY) === "1";
  } catch {
    return false;
  }
}

function writeGuard(value: boolean): void {
  try {
    if (value) {
      window.sessionStorage.setItem(RECOVERY_GUARD_KEY, "1");
    } else {
      window.sessionStorage.removeItem(RECOVERY_GUARD_KEY);
    }
  } catch {
    // sessionStorage may be blocked; recovery still works, only the guard is lost.
  }
}

function readStoredLaunchMode(): string | null {
  try {
    return window.sessionStorage.getItem(LAUNCH_MODE_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** The mode already applied to the document, or a fresh resolution when nothing applied one. */
function currentLaunchMode(): AppLaunchMode {
  const applied = normalizeLaunchMode(document.documentElement.getAttribute(LAUNCH_MODE_ATTRIBUTE));
  if (applied) {
    return applied;
  }

  return resolveLaunchMode({
    param: new URL(window.location.href).searchParams.get(LAUNCH_MODE_PARAM),
    stored: readStoredLaunchMode(),
    heuristic: detectLaunchMode(window),
  }).mode;
}

/**
 * Mount once in the root layout. Applies the resolved launch mode to `<html>` as
 * `data-hosty-launch`, persists a mode the shell declared, and cleans the parameter out of the
 * URL so a copied link cannot carry a shell's presentation into a plain browser tab.
 *
 * Pair it with `launchModeBootstrapScript` in the head: this effect runs after first paint, so
 * without the script an app's own header is painted for a frame before it is hidden. Where that
 * matters most is the native web view, which shows first paint directly — the browser Shell
 * fades its iframe in on load and masks it.
 */
export function HostLaunchBridge() {
  useEffect(() => {
    const url = new URL(window.location.href);
    const param = url.searchParams.get(LAUNCH_MODE_PARAM);
    const { mode, fromParam } = resolveLaunchMode({
      param,
      stored: readStoredLaunchMode(),
      heuristic: detectLaunchMode(window),
    });

    document.documentElement.setAttribute(LAUNCH_MODE_ATTRIBUTE, mode);

    if (fromParam) {
      try {
        window.sessionStorage.setItem(LAUNCH_MODE_STORAGE_KEY, mode);
      } catch {
        // sessionStorage may be blocked. The shell re-declares the mode on every launch and on
        // every page switch it drives, so only app-internal navigation loses it.
      }
    }

    // Cleaned whenever it is present, including an unrecognized value: a parameter this app
    // ignored must not survive into a link someone copies.
    if (url.searchParams.has(LAUNCH_MODE_PARAM)) {
      url.searchParams.delete(LAUNCH_MODE_PARAM);
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }
  }, []);

  return null;
}

/**
 * The resolved launch mode, for logic that needs it — `null` until the first client effect.
 *
 * Rendering off this value costs a frame and risks a hydration mismatch, which is why chrome is
 * hidden with CSS keyed on the root attribute instead. Reach for the hook only where CSS cannot
 * express the decision.
 */
export function useLaunchMode(): AppLaunchMode | null {
  const [mode, setMode] = useState<AppLaunchMode | null>(null);

  useEffect(() => {
    // Effects run child-first, so a consumer deeper in the tree runs before `HostLaunchBridge`
    // has applied the attribute. Resolving here rather than only reading the attribute makes the
    // hook correct in either order.
    setMode(currentLaunchMode());
  }, []);

  return mode;
}

export type AppIdentityBridgeState =
  | { kind: "recovering" }
  | { kind: "active" }
  | { kind: "signin"; openUrl: string | null; embedded: boolean }
  | { kind: "denied" }
  | { kind: "unavailable" }
  | { kind: "misconfigured" };

export interface AppIdentityBridgeProps {
  /** Probe endpoint returning a session status + recovery params. */
  probePath?: string;
  /** Code-exchange endpoint. */
  appCodePath?: string;
  /** Optional app-owned rendering, including loading and active content. Recovery remains SDK-owned. */
  renderState?: (state: AppIdentityBridgeState) => ReactNode;
}

/**
 * Mount once at the top of the root layout body. On first load it consumes a `?code` from
 * the URL (exchanging it for the identity cookie), then probes the session and runs the
 * recovery decision: silent `hosty:auth-required` to the Shell when embedded, a once-per-tab
 * redirect through Core `/open` when standalone, and cards only in fallback/terminal states
 * — never a login UI while recovery is still running.
 */
export function AppIdentityBridge({
  probePath = "/api/auth/identity",
  appCodePath = "/api/auth/app-code",
  renderState,
}: AppIdentityBridgeProps = {}) {
  const [ui, setUi] = useState<AppIdentityBridgeState>({ kind: "recovering" });
  // A launch code is single-use. Strict Mode replays the effect after the URL is cleaned;
  // keep its exchange alive and let the replacement effect await the same response.
  const exchangeRef = useRef<{ path: string; response: Promise<Response> } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function probeAndRecover() {
      // Dedicated controller + setTimeout instead of AbortSignal.any/timeout, which are not
      // available in every browser (a synchronous throw here would stop the bridge from
      // ever rendering). Aborts on effect teardown or when the probe times out.
      const probeController = new AbortController();
      const abortProbe = () => probeController.abort();
      controller.signal.addEventListener("abort", abortProbe, { once: true });
      const probeTimeout = window.setTimeout(abortProbe, IDENTITY_PROBE_TIMEOUT_MS);

      let status: AppSessionStatus | null = null;
      let openUrl: string | null = null;
      let appId: string | null = null;
      try {
        const response = await fetch(probePath, {
          headers: { Accept: "application/json" },
          cache: "no-store",
          signal: probeController.signal,
        });
        const body: unknown = await response.json().catch(() => null);
        status = readProbedSessionStatus(body);
        const recovery = readRecoveryParams(body);
        appId = recovery.appId;
        openUrl = appId ? buildCoreOpenUrl(recovery.corePublicOrigin, appId, window.location) : null;
      } catch {
        // A failed or timed-out probe (Core unreachable) classifies as unavailable below.
        status = null;
      } finally {
        window.clearTimeout(probeTimeout);
        controller.signal.removeEventListener("abort", abortProbe);
      }
      if (cancelled) {
        return;
      }

      const action: RecoveryAction =
        !status || !appId
          ? { kind: "card", card: "unavailable" }
          : decideRecoveryAction({
              status,
              mode: detectLaunchMode(window),
              appId,
              openUrl,
              redirectAlreadyAttempted: readGuard(),
            });

      switch (action.kind) {
        case "none":
          setUi({ kind: "active" });
          return;
        case "post-auth-required": {
          // The payload carries no secret, so targetOrigin "*" is safe — the Shell verifies
          // the sender before acting, and answers by swapping the iframe src.
          try {
            window.parent.postMessage(action.intent, "*");
          } catch {
            // Ignore; the timeout below still falls back to the manual sign-in card.
          }
          const timeoutId = window.setTimeout(() => {
            if (!cancelled) {
              setUi({ kind: "signin", openUrl, embedded: true });
            }
          }, EMBEDDED_RECOVERY_TIMEOUT_MS);
          controller.signal.addEventListener("abort", () => window.clearTimeout(timeoutId), {
            once: true,
          });
          return;
        }
        case "redirect":
          writeGuard(true);
          window.location.assign(action.openUrl);
          return;
        case "card":
          setUi(
            action.card === "signin"
              ? { kind: "signin", openUrl, embedded: false }
              : { kind: action.card },
          );
          return;
      }
    }

    const url = new URL(window.location.href);
    const code = url.searchParams.get("code")?.trim();
    if (code) {
      url.searchParams.delete("code");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
      exchangeRef.current = {
        path: appCodePath,
        response: fetch(appCodePath, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code }),
        }),
      };
    }
    const exchange = exchangeRef.current;
    if (exchange && exchange.path === appCodePath) {
      void exchange.response
        .then((response) => {
          if (cancelled) {
            return;
          }
          if (response.ok) {
            writeGuard(false);
            window.location.reload();
          } else {
            exchangeRef.current = null;
            void probeAndRecover();
          }
        })
        .catch(() => {
          if (!cancelled) {
            exchangeRef.current = null;
            void probeAndRecover();
          }
        });
    } else {
      void probeAndRecover();
    }

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [probePath, appCodePath]);

  if (renderState) return renderState(ui);

  if (ui.kind === "recovering" || ui.kind === "active") {
    return null;
  }

  return (
    <div role="status" style={barStyle}>
      {ui.kind === "signin" ? (
        <>
          <span>Your Hosty session ended.</span>
          {ui.openUrl ? (
            <a
              href={ui.openUrl}
              {...(ui.embedded ? { target: "_blank", rel: "noopener noreferrer" } : {})}
              style={actionStyle}
            >
              Sign in via Hosty
            </a>
          ) : (
            <span>Open this app from the machine running Hosty, or configure a public origin.</span>
          )}
        </>
      ) : ui.kind === "denied" ? (
        <span>You are signed in to Hosty but are not allowed to use this app.</span>
      ) : ui.kind === "misconfigured" ? (
        <span>This app is not configured correctly on the host. Contact the administrator.</span>
      ) : (
        <>
          <span>Can&rsquo;t reach Hosty right now.</span>
          <button type="button" onClick={() => window.location.reload()} style={actionStyle}>
            Retry
          </button>
        </>
      )}
    </div>
  );
}

const barStyle: React.CSSProperties = {
  position: "fixed",
  insetInline: 0,
  bottom: 0,
  zIndex: 2147483647,
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "center",
  gap: "0.75rem",
  padding: "0.75rem 1rem",
  background: "#111827",
  color: "#f9fafb",
  font: "500 0.875rem/1.4 system-ui, sans-serif",
  boxShadow: "0 -1px 0 rgba(255,255,255,0.08)",
};

const actionStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "0.4rem 0.85rem",
  borderRadius: "0.5rem",
  background: "#f9fafb",
  color: "#111827",
  border: "none",
  cursor: "pointer",
  font: "inherit",
  fontWeight: 650,
  textDecoration: "none",
};

function readStoredTheme(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStoredTheme(theme: HostyResolvedTheme, preference: HostyThemePreference): void {
  try {
    window.sessionStorage.setItem(THEME_STORAGE_KEY, theme);
    window.sessionStorage.setItem(THEME_PREFERENCE_STORAGE_KEY, preference);
  } catch {
    // sessionStorage may be blocked. The shell re-declares the theme on every launch and on every
    // page switch it drives, so only app-internal navigation loses it.
  }
}

function clearStoredTheme(): void {
  try {
    window.sessionStorage.removeItem(THEME_STORAGE_KEY);
    window.sessionStorage.removeItem(THEME_PREFERENCE_STORAGE_KEY);
  } catch {
    // Same as above — nothing to keep.
  }
}

export interface HostThemeBridgeProps {
  /**
   * Whether the operating system decides the theme while no shell has spoken — `true` unless the
   * app runs its own theme provider for standalone use (next-themes), which owns that case and
   * whose stored choice the host must not overwrite. Pass the same value to
   * `createThemeBootstrapScript`.
   */
  followSystem?: boolean;
  /**
   * Runs after every application, with the theme just applied. An app that also runs its own
   * theme provider hands that provider the shell's decision here; an app that only follows the
   * host needs nothing.
   */
  onTheme?: (theme: HostyResolvedTheme, preference: HostyThemePreference) => void;
}

/**
 * Mount once in the root layout. Applies the theme from the launch parameters, the value stored
 * for this tab, or the operating system — in that order — persists a declared one, cleans the
 * parameters out of the URL so a copied link cannot carry a shell's presentation into a plain
 * browser tab, and then follows `hosty:shell-theme` posts from the parent for the life of the
 * document.
 *
 * Pair it with `themeBootstrapScript` in the head: this effect runs after first paint, so without
 * the script a document paints in the default theme for a frame before it is corrected. The system
 * preference is followed live only while no shell has spoken — a declared theme is a choice, and a
 * choice is not overruled by the OS.
 */
export function HostThemeBridge({ followSystem = true, onTheme }: HostThemeBridgeProps = {}) {
  const onThemeRef = useRef(onTheme);
  useEffect(() => {
    onThemeRef.current = onTheme;
  }, [onTheme]);

  useEffect(() => {
    const root = document.documentElement;
    const system = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = (theme: HostyResolvedTheme, preference: HostyThemePreference, declared: boolean) => {
      applyTheme(root, theme, preference);
      if (declared) {
        writeStoredTheme(theme, preference);
      } else {
        clearStoredTheme();
      }
      onThemeRef.current?.(theme, preference);
    };

    const url = new URL(window.location.href);
    const resolution = resolveTheme({
      param: url.searchParams.get(THEME_PARAM),
      preferenceParam: url.searchParams.get(THEME_PREFERENCE_PARAM),
      stored: readStoredTheme(THEME_STORAGE_KEY),
      storedPreference: readStoredTheme(THEME_PREFERENCE_STORAGE_KEY),
      systemPrefersDark: system.matches,
    });
    let declared = resolution.source !== "system";
    if (declared || followSystem) {
      apply(resolution.theme, resolution.preference, declared);
    }

    // Cleaned whenever present, including an unrecognized value: a parameter this app ignored
    // must not survive into a link someone copies.
    if (url.searchParams.has(THEME_PARAM) || url.searchParams.has(THEME_PREFERENCE_PARAM)) {
      url.searchParams.delete(THEME_PARAM);
      url.searchParams.delete(THEME_PREFERENCE_PARAM);
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }

    const handleMessage = (event: MessageEvent) => {
      const message = parseShellThemeMessage(event, window);
      if (!message) {
        return;
      }
      declared = true;
      apply(message.theme, message.preference, true);
    };
    const handleSystemChange = () => {
      if (!declared && followSystem) {
        apply(system.matches ? "dark" : "light", "system", false);
      }
    };

    window.addEventListener("message", handleMessage);
    system.addEventListener("change", handleSystemChange);
    return () => {
      window.removeEventListener("message", handleMessage);
      system.removeEventListener("change", handleSystemChange);
    };
  }, []);

  return null;
}
