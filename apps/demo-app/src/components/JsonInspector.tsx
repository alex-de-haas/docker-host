"use client";

import { useRef, useState } from "react";
import { appFetch } from "@hosty-sdk/app/browser-auth";
import { Button } from "./ui/button";

/** Inspect protected JSON without navigating away from the document that owns the app grant. */
export function JsonButton({ href }: { href: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState("");
  async function inspect() {
    setText("Loading…");
    dialog.current?.showModal();
    try {
      const response = await appFetch(href, { cache: "no-store" });
      setText(JSON.stringify(await response.json(), null, 2));
    } catch {
      setText("Could not load JSON. Close this window and try again.");
    }
  }
  return <>
    <Button variant="outline" size="sm" onClick={() => void inspect()}>JSON</Button>
    <dialog ref={dialog} aria-label="JSON response" className="m-auto max-h-[85vh] w-[90vw] max-w-4xl overflow-auto rounded-lg border bg-background p-4 text-foreground backdrop:bg-black/50">
      <Button variant="outline" size="sm" onClick={() => dialog.current?.close()}>Close</Button>
      <pre className="mt-4 whitespace-pre-wrap break-all text-xs">{text}</pre>
    </dialog>
  </>;
}
