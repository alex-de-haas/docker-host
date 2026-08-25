"use client";

import { useCallback, useEffect, useState } from "react";
import { LoaderCircle, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { redirectToCoreLoginIfAuthRequired } from "../../shell/core-api";

// The OAuth consent page (docs/features/mcp-oauth/plan.md). Deliberately standalone: no workspace
// chrome, no admin gate — an ordinary user may consent for an app they can reach, and the page is
// the destination of a browser redirect from outside Shell entirely.
//
// Everything shown here is Core's parked copy of the request, fetched by the id in the URL. The URL
// carries nothing else, so nothing the user consents to can be swapped between validation and this
// render. Refusal is first-class: Deny hands the browser back to the client with access_denied,
// which is an answer, not an error.

type ConsentView = {
  id: string;
  clientName: string;
  audienceDisplayName: string;
  audience: string;
  scopes: string[];
  actingUser: string;
  expiresInSeconds: number;
};

// The stable scope constants, said in words a person consents to.
const SCOPE_TEXT: Record<string, string> = {
  "mcp:read": "Use read-only tools — look things up, never change anything",
  "mcp:lifecycle": "Start, stop and restart apps",
};

export function OAuthConsentPage({ coreOrigin }: { coreOrigin: string }) {
  const [view, setView] = useState<ConsentView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const requestId = new URLSearchParams(window.location.search).get("request");
      if (!requestId) {
        setError("This page needs an authorization request to show. Start again from the client.");
        return;
      }

      try {
        const response = await fetch(
          `${coreOrigin}/api/auth/oauth/requests/${encodeURIComponent(requestId)}`,
          { credentials: "include" },
        );
        // Not signed in yet is the likeliest case of all: the browser arrived here straight from an
        // agent client. Login keeps this page as its continuation and comes back.
        redirectToCoreLoginIfAuthRequired(response, coreOrigin);
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { message?: string } | null;
          setError(body?.message ?? "This authorization request expired or was already answered. Start again from the client.");
          return;
        }

        setView((await response.json()) as ConsentView);
      } catch (cause) {
        if (cause instanceof Error && cause.name === "AuthRequiredRedirectError") {
          return;
        }
        setError("Could not reach Hosty Core.");
      }
    })();
  }, [coreOrigin]);

  const decide = useCallback(
    async (decision: "approve" | "deny") => {
      if (!view) return;
      setBusy(true);
      setError(null);
      try {
        const csrfResponse = await fetch(`${coreOrigin}/api/auth/csrf`, { credentials: "include" });
        redirectToCoreLoginIfAuthRequired(csrfResponse, coreOrigin);
        const csrf = ((await csrfResponse.json()) as { token: string }).token;

        const response = await fetch(
          `${coreOrigin}/api/auth/oauth/requests/${encodeURIComponent(view.id)}/decide`,
          {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json", "X-Hosty-CSRF": csrf },
            body: JSON.stringify({ decision }),
          },
        );
        redirectToCoreLoginIfAuthRequired(response, coreOrigin);
        const body = (await response.json()) as { redirectTo?: string; message?: string };
        if (!response.ok || !body.redirectTo) {
          setError(body.message ?? "The decision could not be recorded.");
          setBusy(false);
          return;
        }

        // The browser carries the answer back to the client itself; Core never cross-origin
        // redirects here, which is what lets this page show an error instead of stranding the user.
        window.location.assign(body.redirectTo);
      } catch (cause) {
        if (cause instanceof Error && cause.name === "AuthRequiredRedirectError") {
          return;
        }
        setError("Could not reach Hosty Core.");
        setBusy(false);
      }
    },
    [coreOrigin, view],
  );

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-md space-y-5 rounded-lg border p-6 shadow-sm">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-5 text-muted-foreground" />
          <h1 className="text-base font-semibold">Authorize an agent client</h1>
        </div>

        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : !view ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" /> Loading the request…
          </p>
        ) : (
          <>
            <p className="text-sm">
              <span className="font-medium">{view.clientName}</span> is asking to act as{" "}
              <span className="font-medium">{view.actingUser}</span> on{" "}
              <span className="font-medium">{view.audienceDisplayName}</span>.
            </p>

            <ul className="space-y-1 rounded-md border bg-muted/30 p-3 text-sm">
              {view.scopes.map((scope) => (
                <li key={scope}>
                  {SCOPE_TEXT[scope] ?? scope}
                  <span className="ml-1 font-mono text-xs text-muted-foreground">({scope})</span>
                </li>
              ))}
            </ul>

            <p className="text-xs text-muted-foreground">
              Approving issues the client its own revocable credential for exactly this. You can
              withdraw it any time under Settings → Access tokens.
            </p>

            <div className="flex gap-2">
              <Button type="button" disabled={busy} onClick={() => void decide("approve")}>
                {busy ? <LoaderCircle className="size-4 animate-spin" /> : null}
                Approve
              </Button>
              <Button type="button" variant="outline" disabled={busy} onClick={() => void decide("deny")}>
                Deny
              </Button>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
