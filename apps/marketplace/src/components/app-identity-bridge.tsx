"use client";

import { useEffect, useState } from "react";

// Once-per-tab guard so a standalone app that returns from Core still unauthorized does not bounce
// through /open forever. Cleared on a successful code exchange.
const RECOVERY_GUARD_KEY = "hosty.auth.recovery-attempted";
// How long an embedded frame waits for Shell to reissue a launch code before showing the manual
// sign-in fallback (i.e. it is embedded by something other than Hosty Shell).
const EMBEDDED_RECOVERY_TIMEOUT_MS = 4_000;

type RecoveryUi =
  | { kind: "hidden" }
  | { kind: "signin"; openUrl: string; embedded: boolean }
  | { kind: "denied" }
  | { kind: "unavailable" };

// Reads the session status out of this app's /api/auth/identity payload.
function readIdentityStatus(body: unknown): string | null {
  if (!body || typeof body !== "object") {
    return null;
  }
  const status = (body as { status?: unknown }).status;
  return typeof status === "string" ? status : null;
}

function buildOpenUrl(corePublicOrigin: string, appId: string): string {
  const target = new URL(`/api/apps/${encodeURIComponent(appId)}/open`, corePublicOrigin);
  // Exclude any URL fragment: Core rejects redirect URIs with a fragment (redirect_uri_invalid), and
  // the fragment (hash-routing state, user anchors) never survives a server redirect anyway.
  const { origin, pathname, search } = window.location;
  target.searchParams.set("redirectUri", `${origin}${pathname}${search}`);
  return target.toString();
}

export function AppIdentityBridge({ corePublicOrigin, appId }: { corePublicOrigin: string; appId: string }) {
  const [ui, setUi] = useState<RecoveryUi>({ kind: "hidden" });

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    const readGuard = () => {
      try {
        return window.sessionStorage.getItem(RECOVERY_GUARD_KEY) === "1";
      } catch {
        return false;
      }
    };
    const writeGuard = (value: boolean) => {
      try {
        if (value) {
          window.sessionStorage.setItem(RECOVERY_GUARD_KEY, "1");
        } else {
          window.sessionStorage.removeItem(RECOVERY_GUARD_KEY);
        }
      } catch {
        // sessionStorage may be blocked; recovery still works, only the once-per-tab guard is lost.
      }
    };

    async function probeAndRecover() {
      let status: string | null;
      try {
        const response = await fetch("/api/auth/identity", {
          headers: { Accept: "application/json" },
          cache: "no-store",
          signal: controller.signal,
        });
        status = readIdentityStatus(await response.json().catch(() => null));
      } catch {
        // A failed probe (Core unreachable) is treated like "unavailable": keep the cookie, offer retry.
        status = null;
      }
      if (cancelled) {
        return;
      }

      if (status === "active") {
        setUi({ kind: "hidden" });
        return;
      }
      if (status === "forbidden") {
        // Terminal: signed in but not allowed. Never auto-redirect (would loop).
        setUi({ kind: "denied" });
        return;
      }
      if (status !== "not-present" && status !== "expired") {
        // "unavailable" / "error" / null: transient. Do not drop the session; let the user retry.
        setUi({ kind: "unavailable" });
        return;
      }

      const openUrl = buildOpenUrl(corePublicOrigin, appId);
      if (window.self !== window.top) {
        // Embedded: the sandbox forbids top navigation, so ask Shell to reissue a code. The payload
        // carries no secret, so targetOrigin "*" is safe — Shell verifies the sender before acting.
        try {
          window.parent.postMessage({ type: "hosty:auth-required", appId }, "*");
        } catch {
          // Ignore; the timeout below still falls back to the manual sign-in card.
        }
        window.setTimeout(() => {
          if (!cancelled) {
            setUi({ kind: "signin", openUrl, embedded: true });
          }
        }, EMBEDDED_RECOVERY_TIMEOUT_MS);
        return;
      }

      // Standalone: auto-recover once per tab, then fall back to an explicit sign-in button.
      if (!readGuard()) {
        writeGuard(true);
        window.location.assign(openUrl);
        return;
      }
      setUi({ kind: "signin", openUrl, embedded: false });
    }

    const url = new URL(window.location.href);
    const code = url.searchParams.get("code");
    if (code) {
      url.searchParams.delete("code");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
      void fetch("/api/auth/app-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
        signal: controller.signal,
      })
        .then((response) => {
          if (cancelled) {
            return;
          }
          if (response.ok) {
            writeGuard(false);
            window.location.reload();
          } else {
            void probeAndRecover();
          }
        })
        .catch(() => {
          if (!cancelled) {
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
  }, [corePublicOrigin, appId]);

  if (ui.kind === "hidden") {
    return null;
  }

  return (
    <div
      role="status"
      style={{
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
      }}
    >
      {ui.kind === "signin" ? (
        <>
          <span>Your Hosty session ended.</span>
          <a
            href={ui.openUrl}
            {...(ui.embedded ? { target: "_blank", rel: "noreferrer" } : {})}
            style={signInButtonStyle}
          >
            Sign in via Hosty
          </a>
        </>
      ) : ui.kind === "denied" ? (
        <span>You are signed in to Hosty but are not allowed to use this app.</span>
      ) : (
        <>
          <span>Can&rsquo;t reach Hosty right now.</span>
          <button type="button" onClick={() => window.location.reload()} style={signInButtonStyle}>
            Retry
          </button>
        </>
      )}
    </div>
  );
}

const signInButtonStyle: React.CSSProperties = {
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
