"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { appFetch } from "@hosty-sdk/app/browser-auth";
import { coreApiPath } from "../core-transport.js";

type ReviewEvent = { url: string; statusUrl: string; headers: Headers; complete: () => void; fail: (reason: Error) => void };
export function SettingsConfirmationDialog() {
  const [review, setReview] = useState<ReviewEvent | null>(null), [error, setError] = useState("");
  const current = useRef<ReviewEvent | null>(null);
  const cancelIntent = useRef<ReviewEvent | null>(null);
  const cancellation = useRef<{ review: ReviewEvent; controller: AbortController } | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const settle = useCallback((entry: ReviewEvent, reason?: Error) => {
    if (current.current !== entry) return;
    current.current = null; cancelIntent.current = null;
    cancellation.current?.controller.abort(); cancellation.current = null;
    setCancelling(false); setReview(null);
    if (reason) entry.fail(reason); else entry.complete();
  }, []);
  useEffect(() => {
    const receive = (event: Event) => {
      const next = (event as CustomEvent<ReviewEvent>).detail;
      if (current.current) { next.fail(new Error("Finish the open settings review first.")); return; }
      current.current = next; cancelIntent.current = null; setReview(next); setCancelling(false); setError(""); window.open(next.url, "_blank", "noopener,noreferrer");
    };
    window.addEventListener("hosty:settings-review", receive);
    return () => {
      window.removeEventListener("hosty:settings-review", receive);
      cancellation.current?.controller.abort(); cancellation.current = null;
      current.current?.fail(new Error("Settings review was interrupted. Your draft was not saved.")); current.current = null; cancelIntent.current = null;
    };
  }, []);
  useEffect(() => {
    if (!review) return;
    let disposed = false, timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const response = await appFetch(coreApiPath(review.statusUrl), { credentials: "same-origin", signal: controller.signal });
        const result = await response.json() as { status?: string; error?: string; message?: string };
        if (disposed || current.current !== review) return;
        if (response.status === 404 || response.status === 403) { settle(review, new Error(result.message ?? "This review is no longer available. Your draft is preserved.")); return; }
        if (!response.ok) throw new Error(result.message ?? "Core could not read the review.");
        // Approval has not applied the change yet. An unresolved Cancel must not trigger it.
        if (result.status === "succeeded" || (result.status === "approved" && cancelIntent.current !== review)) { settle(review); return; }
        if (result.status === "denied" || result.status === "failed") { settle(review, new Error(result.error ?? "The change was cancelled. Your draft is preserved.")); return; }
        if (cancelIntent.current !== review) setError("");
      } catch (cause) { if (!disposed && current.current === review) setError(cause instanceof Error ? cause.message : String(cause)); }
      if (!disposed && current.current === review) timer = setTimeout(poll, 1500);
    };
    void poll(); return () => { disposed = true; controller.abort(); clearTimeout(timer); };
  }, [review, settle]);
  const cancel = async () => {
    const entry = current.current;
    if (!entry || cancellation.current?.review === entry) return;
    const request = { review: entry, controller: new AbortController() };
    cancelIntent.current = entry;
    cancellation.current = request; setCancelling(true); setError("");
    try {
      const response = await appFetch(coreApiPath(entry.statusUrl), { method: "DELETE", credentials: "same-origin", headers: entry.headers, signal: request.controller.signal });
      if (request.controller.signal.aborted || current.current !== entry) return;
      if (!response.ok && response.status !== 404) throw new Error("Core could not cancel this review. Try again.");
      settle(entry, new Error("The change was cancelled. Your draft is preserved."));
    } catch (cause) {
      if (!request.controller.signal.aborted && current.current === entry) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (cancellation.current === request) { cancellation.current = null; setCancelling(false); }
    }
  };
  return <Dialog open={Boolean(review)} onOpenChange={open => { if (!open) void cancel(); }}><DialogContent><DialogHeader>
    <DialogTitle>Confirm in Core</DialogTitle><DialogDescription>Review the changes in the Core window. This page finishes saving after your confirmation.</DialogDescription>
  </DialogHeader>{error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
  <DialogFooter><Button variant="outline" disabled={cancelling} onClick={() => void cancel()}>{cancelling ? "Cancelling…" : "Cancel"}</Button><Button asChild><a href={review?.url} target="_blank" rel="noopener noreferrer">Open Core confirmation</a></Button></DialogFooter></DialogContent></Dialog>;
}
