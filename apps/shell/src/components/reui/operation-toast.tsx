"use client";

// Adapted from ReUI c-sonner-14 and c-sonner-4 (radix-vega). See ./LICENSE.
// Keep the rich error/details/actions composition; use Hosty's theme and real operation callbacks.
import { createContext, useContext, useRef, useState } from "react";
import { Check, Copy, LoaderCircle, MessageSquarePlus, X } from "lucide-react";
import { toast as sonner, type ExternalToast } from "sonner";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

export type ErrorReport = { title: string; description?: string; appId?: string };
type AssistantFeedback = {
  installed: boolean;
  unavailableReason?: string;
  ask: (report: ErrorReport, requestId: string) => Promise<void | boolean>;
};
export const AssistantFeedbackContext = createContext<AssistantFeedback>({ installed: false, ask: async () => {} });

export function errorReportText(report: ErrorReport) {
  return [report.appId && `Application: ${report.appId}`, report.title, report.description].filter(Boolean).join("\n\n");
}

export function OperationErrorToast({ id, report }: { id: string | number; report: ErrorReport }) {
  const assistant = useContext(AssistantFeedbackContext);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const pending = useRef(false);
  const requestId = useRef<string | null>(null);
  const text = errorReportText(report);
  return <div className="flex w-full flex-col gap-3 rounded-lg border bg-popover p-4 text-popover-foreground shadow-lg">
    <div className="flex items-start gap-3">
      <div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-destructive text-white"><X className="size-3.5" aria-hidden /></div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="break-words text-sm font-semibold">{report.title}</p>
        {report.appId && <p className="break-all text-xs text-muted-foreground">{report.appId}</p>}
      </div>
      <Button size="icon-sm" variant="ghost" aria-label="Dismiss notification" onClick={() => sonner.dismiss(id)}><X /></Button>
    </div>
    {report.description && <><Separator /><p className="max-h-52 overflow-y-auto break-words whitespace-pre-wrap text-sm text-muted-foreground">{report.description}</p></>}
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" aria-label={copied ? "Error copied" : "Copy error"} onClick={async () => {
        try { await navigator.clipboard.writeText(text); setCopied(true); setActionError(null); }
        catch { setActionError("Clipboard access failed. Select and copy the error text manually."); }
      }}>{copied ? <Check /> : <Copy />}{copied ? "Copied" : "Copy"}</Button>
      {assistant.installed && <span title={assistant.unavailableReason}>
        <Button size="sm" variant="outline" disabled={busy || !!assistant.unavailableReason} onClick={async () => {
          if (pending.current) return;
          pending.current = true; setBusy(true); setActionError(null);
          requestId.current ??= crypto.randomUUID();
          try { if (await assistant.ask(report, requestId.current) !== false) sonner.dismiss(id); }
          catch (error) { setActionError(error instanceof Error ? error.message : "Could not open the assistant. Retry."); }
          finally { pending.current = false; setBusy(false); }
        }}>{busy ? <LoaderCircle className="animate-spin" /> : <MessageSquarePlus />}Ask assistant</Button>
      </span>}
    </div>
    {actionError && <p role="alert" className="text-xs text-destructive">{actionError}</p>}
  </div>;
}

type ErrorOptions = Omit<ExternalToast, "description"> & { description?: string; appId?: string };
function error(title: string, options: ErrorOptions = {}) {
  const { appId, description, ...rest } = options;
  return sonner.custom(id => <OperationErrorToast key={`${id}:${title}:${description ?? ""}:${appId ?? ""}`} id={id} report={{ title, description, appId }} />, {
    duration: 20_000, ...rest, className: cn("w-[var(--width)]", rest.className),
  });
}

// One import for operation feedback; success/warning/progress preserve Sonner's API.
export const toast = Object.assign((...args: Parameters<typeof sonner>) => sonner(...args), sonner, { error });
