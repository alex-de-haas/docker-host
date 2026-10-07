"use client";
import { AppIdentityBridge, MissingPermissionsNotice, type AppIdentityBridgeState } from "@hosty-sdk/app/react";
import { PlansWorkbench } from "./workbench";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { LoadingIndicator } from "./loading-indicator";

export function PlansSession() { return <AppIdentityBridge renderState={renderState} />; }
function renderState(state: AppIdentityBridgeState) {
  if (state.kind === "active") return <><MissingPermissionsNotice /><PlansWorkbench /></>;
  const pending = state.kind === "recovering";
  const message = pending ? "Connecting to your Hosty session…" : state.kind === "signin" ? state.error ?? "Sign in through Hosty to read plans." : state.kind === "denied" ? "Plans is available only to Hosty administrators." : state.kind === "misconfigured" ? "Plans could not establish a session. Check its Hosty configuration." : "Hosty could not verify this session. Check Core and retry.";
  return <main className="mx-auto max-w-xl px-4 pt-[15vh]"><Card>
    <CardHeader><CardTitle>Hosty Plans</CardTitle></CardHeader>
    <CardContent>{pending ? <LoadingIndicator message={message} /> : <Alert><AlertDescription>{message}</AlertDescription></Alert>}</CardContent>
    <CardFooter>{state.kind === "signin" && state.signIn ? <Button onClick={state.signIn}>Sign in via Hosty</Button> : state.kind === "signin" && state.openUrl ? <Button asChild><a href={state.openUrl} {...(state.embedded ? { target: "_blank", rel: "noopener noreferrer" } : {})}>Sign in via Hosty</a></Button> : !pending && state.kind !== "denied" ? <Button variant="outline" onClick={() => window.location.reload()}>Retry</Button> : null}</CardFooter>
  </Card></main>;
}
