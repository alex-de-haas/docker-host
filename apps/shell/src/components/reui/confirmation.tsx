"use client";

// Adapted from ReUI c-alert-dialog-5 (radix-vega). See ./LICENSE.
import { useCallback, useEffect, useRef, useState } from "react";
import { CircleHelp, Trash2 } from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogMedia, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

type Confirmation = { title: string; description: string; action: string; destructive?: boolean };

/** A single explicit decision; overlapping requests are cancelled, never queued for later. */
export function useConfirmation(scope?: string) {
  const [request, setRequest] = useState<Confirmation | null>(null);
  const pending = useRef<((accepted: boolean) => void) | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const settle = useCallback((accepted: boolean) => {
    const resolve = pending.current;
    pending.current = null;
    setRequest(null);
    resolve?.(accepted);
  }, []);
  useEffect(() => () => settle(false), [scope, settle]);
  const confirm = useCallback((next: Confirmation): Promise<boolean> => {
    if (pending.current) return Promise.resolve(false);
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return new Promise(resolve => { pending.current = resolve; setRequest(next); });
  }, []);

  const dialog = <AlertDialog open={request !== null} onOpenChange={open => { if (!open) settle(false); }}>
    <AlertDialogContent onCloseAutoFocus={event => {
      event.preventDefault();
      if (trigger.current?.isConnected) trigger.current.focus();
    }}>
      <AlertDialogHeader>
        <AlertDialogMedia>{request?.destructive ? <Trash2 /> : <CircleHelp />}</AlertDialogMedia>
        <AlertDialogTitle>{request?.title}</AlertDialogTitle>
        <AlertDialogDescription className="break-words whitespace-pre-wrap">{request?.description}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel variant="ghost" onClick={() => settle(false)}>Cancel</AlertDialogCancel>
        <AlertDialogAction variant={request?.destructive ? "destructive" : "default"} onClick={() => settle(true)}>{request?.action}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
  return { confirm, dialog };
}
