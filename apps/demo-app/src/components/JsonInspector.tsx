"use client";

import { useId, useRef, useState } from "react";
import { appFetch } from "@hosty-sdk/app/browser-auth";
import { Button } from "./ui/button";
import { DemoAlert, DemoLoading } from "./DemoFeedback";

/** Inspect protected JSON without navigating away from the document that owns the app grant. */
export function JsonButton({ href }: { href: string }) {
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const [state, setState] = useState<{ text?: string; error?: string }>({});
  async function inspect() {
    setState({});
    if (!dialog.current?.open) dialog.current?.showModal();
    try {
      const response = await appFetch(href, { cache: "no-store" });
      setState({ text: JSON.stringify(await response.json(), null, 2) });
    } catch {
      setState({ error: "Could not load JSON. Try again." });
    }
  }
  return <>
    <Button variant="outline" size="sm" onClick={() => void inspect()}>JSON</Button>
    <dialog ref={dialog} aria-labelledby={titleId} className="m-auto max-h-[85dvh] w-[calc(100vw-2rem)] max-w-4xl overflow-auto rounded-xl border bg-card p-4 text-card-foreground backdrop:bg-black/50">
      <div className="flex items-center justify-between gap-3"><h2 id={titleId} className="text-base font-semibold">JSON response</h2>
        <Button variant="outline" size="sm" onClick={() => dialog.current?.close()}>Close</Button></div>
      <div className="mt-4">{state.error ? <DemoAlert action={<Button variant="outline" size="sm" onClick={() => void inspect()}>Retry</Button>}>{state.error}</DemoAlert>
        : state.text === undefined ? <DemoLoading label="Loading JSON…" /> : <pre className="whitespace-pre-wrap wrap-anywhere font-mono text-xs leading-5">{state.text}</pre>}</div>
    </dialog>
  </>;
}
