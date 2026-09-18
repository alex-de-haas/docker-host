"use client";

import { useEffect, useState } from "react";
import { Dialog } from "radix-ui";
import { Check, Copy, ExternalLink, Loader2, X } from "lucide-react";
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
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 grid max-h-[90dvh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 gap-5 overflow-y-auto rounded-xl border bg-background p-6 text-sm shadow-xl">
          <div className="grid gap-2 pr-5">
            <Dialog.Title className="text-base font-semibold">
              {login.status === "complete"
                ? "ChatGPT connected"
                : "Sign in with ChatGPT"}
            </Dialog.Title>
            <Dialog.Description className="text-muted-foreground">
              {pending
                ? "Open ChatGPT in your browser, sign in, and enter this one-time code. You do not need the ChatGPT app."
                : login.status === "complete"
                  ? "Your provider is ready to select for a new chat."
                  : (login.message ??
                    "Sign-in cancelled. You can try again from the provider menu.")}
            </Dialog.Description>
          </div>
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
                <p role="alert" className="text-xs text-destructive">
                  {copyError}
                </p>
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
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {busy ? "Please wait…" : pending ? "Cancel sign-in" : "Done"}
          </Button>
          <Dialog.Close asChild>
            <Button
              className="absolute right-2 top-2"
              size="icon-sm"
              variant="ghost"
              disabled={busy}
              title="Close"
              aria-label="Close sign-in"
            >
              <X aria-hidden />
            </Button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
