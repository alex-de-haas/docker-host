"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { MessageTimestamp } from "./message-timestamp";

async function copyMessageText(text: string) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);

  // Plain HTTP hosts lack the Clipboard API. Supply the text without moving focus or selection.
  let written = false;
  function onCopy(event: ClipboardEvent) {
    if (!event.clipboardData) return;
    event.clipboardData.setData("text/plain", text);
    event.preventDefault();
    written = true;
  }
  document.addEventListener("copy", onCopy);
  try {
    if (!document.execCommand("copy") || !written) throw new Error("Could not copy message.");
  } finally {
    document.removeEventListener("copy", onCopy);
  }
}

export function MessageFooter({ text, ts, children, active = false, className }: {
  text: string;
  ts?: string;
  children?: ReactNode;
  active?: boolean;
  className?: string;
}) {
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (copyStatus === "idle") return;
    const timer = window.setTimeout(() => setCopyStatus("idle"), 2500);
    return () => window.clearTimeout(timer);
  }, [copyStatus]);

  async function copy() {
    try {
      await copyMessageText(text);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  }

  const copied = copyStatus === "copied";
  const copyLabel = copied ? "Message copied" : "Copy message";
  return <div data-slot="message-footer" className={cn(
    "flex flex-wrap items-center gap-x-1 px-1 text-xs text-muted-foreground",
    !active && copyStatus === "idle" && "[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/message:opacity-100 [@media(hover:hover)]:group-focus-within/message:opacity-100",
    className,
  )}>
    {text.trim() && <Button type="button" size="icon-sm" variant="ghost" aria-label={copyLabel} title={copyLabel} onClick={copy}>
      {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
    </Button>}
    {children}
    <span role="status" className={copyStatus === "failed" ? undefined : "sr-only"}>
      {copied ? "Message copied" : copyStatus === "failed" ? "Could not copy message." : ""}
    </span>
    <MessageTimestamp ts={ts} />
  </div>;
}
