"use client";

import { CORE_PROVIDER_ID, type Provider } from "@/lib/api";

// Both controls say what they DO, not what they are. A button labelled "Disabled" reads equally as
// "this is off" and "click to disable", and the operator cannot tell which without clicking — which
// is the one action they were trying to decide about. A switch's position is the state; a select
// shows the chosen option as a value with the alternative beside it.
export function ProviderRow({
  provider,
  enabled,
  autoAllow,
  autoAllowSupported,
  harnessName,
  busy,
  onToggle,
  onApprovalChange,
}: {
  provider: Provider;
  enabled: boolean;
  autoAllow: boolean;
  /** Whether the selected harness consults the approval mode at all; false greys the select out. */
  autoAllowSupported: boolean;
  harnessName: string;
  busy: boolean;
  onToggle: (next: boolean) => void;
  onApprovalChange: (autoAllow: boolean) => void;
}) {
  const name = provider.displayName || provider.appId;
  const isCore = provider.appId === CORE_PROVIDER_ID;

  // Three different things the select can be saying, and the tooltip has to say the right one: the
  // harness ignores it, Core's own annotations are being trusted, or an app's word is.
  const approvalTitle = !autoAllowSupported
    ? `The ${harnessName} harness decides on its own which calls pause; this choice has no effect there.`
    : isCore
      ? "Core annotates its own tools, so running the read-only ones unprompted trusts the platform rather than a third party. Lifecycle and update tools always ask."
      : "The app declares which of its tools are read-only. Choosing to run them unprompted means trusting that declaration: a tool the app mislabels would then run without asking you.";

  return (
    <div className="flex items-start gap-3 rounded-lg border p-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{name}</div>
        <div className="truncate text-xs text-muted-foreground">
          {isCore
            ? "Core's own control-plane tools · read-only for the assistant; lifecycle and updates stay on the CLI"
            : `${provider.appId}${provider.url ? ` · ${provider.url}` : " · no reachable URL"}${provider.running ? "" : " · stopped"}`}
        </div>
      </div>

      <select
        className="rounded-md border bg-muted/40 px-2 py-1.5 text-sm disabled:opacity-50"
        value={autoAllow ? "auto" : "ask"}
        // Meaningless while the app cannot be reached at all, or on a harness that never asks.
        disabled={!enabled || busy || !autoAllowSupported}
        aria-label={`Approval for ${name}`}
        title={approvalTitle}
        onChange={(event) => onApprovalChange(event.target.value === "auto")}
      >
        <option value="ask">Ask before every tool</option>
        <option value="auto">Run read-only tools unprompted</option>
      </select>

      <label className="relative inline-flex h-5 w-9 flex-none cursor-pointer items-center">
        <input
          type="checkbox"
          className="peer absolute inset-0 z-10 m-0 h-full w-full cursor-pointer opacity-0"
          checked={enabled}
          disabled={busy}
          aria-label={`Let the assistant use ${name}'s tools`}
          onChange={(event) => onToggle(event.target.checked)}
        />
        <span
          className="h-full w-full rounded-full bg-muted transition-colors peer-checked:bg-primary peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring peer-disabled:opacity-50"
          aria-hidden
        />
        <span
          className="pointer-events-none absolute left-0.5 h-4 w-4 rounded-full bg-background transition-transform peer-checked:translate-x-4"
          aria-hidden
        />
      </label>
    </div>
  );
}
