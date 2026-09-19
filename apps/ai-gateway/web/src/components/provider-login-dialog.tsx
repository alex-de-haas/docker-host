"use client";

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Check, Copy, ExternalLink, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export type ProviderLogin = {
  id: string;
  connectionId: string;
  status: "pending" | "complete" | "failed" | "cancelled";
  verificationUrl?: string;
  userCode?: string;
  message?: string;
};

export function ProviderLoginDialog({
  login,
  busy,
  error,
  onClose,
}: {
  login: ProviderLogin;
  busy: boolean;
  error: string | null;
  onClose(): void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const pending = login.status === "pending";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-md"
        showCloseButton={!busy}
      >
        <DialogHeader>
          <DialogTitle>
            {login.status === "complete"
              ? "ChatGPT connected"
              : "Sign in with ChatGPT"}
          </DialogTitle>
          <DialogDescription>
            {pending
              ? "Open ChatGPT in your browser, sign in, and enter this one-time code. You do not need the ChatGPT app."
              : login.status === "complete"
                ? "Your provider is ready to select for a new chat."
                : (login.message ??
                  "Sign-in cancelled. You can try again from the provider menu.")}
          </DialogDescription>
        </DialogHeader>
        {pending && (
          <>
            <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/30 px-4 py-3">
              <code className="select-all text-xl font-semibold tracking-widest">
                {login.userCode ?? "Preparing…"}
              </code>
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={!login.userCode}
                title={copied ? "Copied" : "Copy code"}
                aria-label={copied ? "Code copied" : "Copy code"}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(login.userCode!);
                    setCopied(true);
                    setCopyError(null);
                  } catch {
                    setCopyError(
                      "Could not copy automatically. Select the code and copy it manually.",
                    );
                  }
                }}
              >
                {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
              </Button>
            </div>
            <span className="sr-only" role="status">
              {copied ? "Code copied to clipboard" : ""}
            </span>
            {copyError && (
              <Alert variant="destructive">
                <AlertDescription>{copyError}</AlertDescription>
              </Alert>
            )}
            {login.verificationUrl && (
              <Button asChild>
                <a
                  href={login.verificationUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open ChatGPT sign-in <ExternalLink aria-hidden />
                </a>
              </Button>
            )}
            <div className="grid gap-2 text-xs text-muted-foreground">
              <p className="flex items-center gap-2">
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                Waiting for confirmation…
              </p>
              <p>
                Enable device-code login in ChatGPT security settings if
                required. This attempt expires after 15 minutes.
              </p>
            </div>
          </>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {busy ? "Please wait…" : pending ? "Cancel sign-in" : "Done"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
