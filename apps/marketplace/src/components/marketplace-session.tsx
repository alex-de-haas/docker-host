"use client";

import { AppIdentityBridge, type AppIdentityBridgeState } from "@hosty-sdk/app/react";
import { LoaderCircle, TriangleAlert } from "lucide-react";
import { Storefront } from "./storefront";
import { Button } from "./ui/button";

export function MarketplaceSession() {
  return <AppIdentityBridge renderState={renderSession} />;
}

function renderSession(state: AppIdentityBridgeState) {
  if (state.kind === "active") return <Storefront />;
  const pending = state.kind === "recovering";
  const message = pending ? "Connecting to your Hosty session…"
    : state.kind === "signin" ? "Sign in through Hosty to open Marketplace."
    : state.kind === "denied" ? "Your account does not have access to Marketplace."
    : state.kind === "misconfigured" ? "Marketplace cannot establish a session. Check its Hosty configuration."
    : "Hosty could not verify your session. Check the Core connection and try again.";
  return <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">
    <section role={pending ? "status" : "alert"} className="flex min-h-60 flex-col items-center justify-center gap-3 rounded-lg border p-6 text-center">
      {pending ? <LoaderCircle className="size-6 animate-spin text-muted-foreground" /> : <TriangleAlert className="size-6 text-amber-600" />}
      <p className="max-w-lg text-sm">{message}</p>
      {state.kind === "signin" && state.openUrl ? <Button asChild><a href={state.openUrl}
        {...(state.embedded ? { target: "_blank", rel: "noopener noreferrer" } : {})}>Sign in via Hosty</a></Button>
        : !pending ? <Button variant="outline" onClick={() => window.location.reload()}>Retry</Button> : null}
    </section>
  </main>;
}
