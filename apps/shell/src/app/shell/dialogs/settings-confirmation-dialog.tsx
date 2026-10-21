"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { appFetch } from "@hosty-sdk/app/browser-auth";
import { coreApiPath } from "../core-transport.js";

type ReviewEvent = { url: string; statusUrl: string; headers: Headers; complete: () => void; fail: (reason: Error) => void };
export function SettingsConfirmationDialog() {
  const [review, setReview] = useState<ReviewEvent | null>(null), [error, setError] = useState("");
  const current = useRef<ReviewEvent | null>(null);
  useEffect(() => {
    const receive = (event: Event) => {
      const next = (event as CustomEvent<ReviewEvent>).detail;
      if (current.current) { next.fail(new Error("Finish the open settings review first.")); return; }
      current.current = next; setReview(next); setError(""); window.open(next.url, "_blank", "noopener,noreferrer");
    };
    window.addEventListener("hosty:settings-review", receive);
    return () => { window.removeEventListener("hosty:settings-review", receive); current.current?.fail(new Error("Settings review was interrupted. Your draft was not saved.")); current.current = null; };
  }, []);
  useEffect(() => {
    if (!review) return;
    let disposed = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await appFetch(coreApiPath(review.statusUrl), { credentials: "same-origin" });
        const result = await response.json() as { status?: string; error?: string; message?: string };
        if (disposed) return;
        if (response.status === 404 || response.status === 403) { current.current = null; setReview(null); review.fail(new Error(result.message ?? "This review is no longer available. Your draft is preserved.")); return; }
        if (!response.ok) throw new Error(result.message ?? "Core could not read the review.");
        if (result.status === "approved" || result.status === "succeeded") { current.current = null; setReview(null); review.complete(); return; }
        if (result.status === "denied" || result.status === "failed") { current.current = null; setReview(null); review.fail(new Error(result.error ?? "The change was cancelled. Your draft is preserved.")); return; }
        setError("");
      } catch (cause) { if (!disposed) setError(cause instanceof Error ? cause.message : String(cause)); }
      if (!disposed) timer = setTimeout(poll, 1500);
    };
    void poll(); return () => { disposed = true; clearTimeout(timer); };
  }, [review]);
  const cancel = async () => {
    if (!review) return;
    try {
      const response = await appFetch(coreApiPath(review.statusUrl), { method: "DELETE", credentials: "same-origin", headers: review.headers });
      if (!response.ok && response.status !== 404) throw new Error("Core could not cancel this review. Try again.");
      current.current = null; setReview(null); review.fail(new Error("The change was cancelled. Your draft is preserved."));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <Dialog open={Boolean(review)} onOpenChange={open => { if (!open) void cancel(); }}><DialogContent><DialogHeader>
    <DialogTitle>Confirm in Core</DialogTitle><DialogDescription>Review the changes in the Core window. This page finishes saving after your confirmation.</DialogDescription>
  </DialogHeader>{error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
  <DialogFooter><Button variant="outline" onClick={() => void cancel()}>Cancel</Button><Button asChild><a href={review?.url} target="_blank" rel="noopener noreferrer">Open Core confirmation</a></Button></DialogFooter></DialogContent></Dialog>;
}
