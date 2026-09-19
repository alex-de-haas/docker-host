"use client";

import { CORE_PROVIDER_ID, type Provider } from "@/lib/api";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

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
    <div className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
      <div className="min-w-0 basis-full sm:flex-1 sm:basis-auto">
        <div className="text-sm font-medium">{name}</div>
        <div className="truncate text-xs text-muted-foreground">
          {isCore
            ? "Core's own control-plane tools · read-only for the assistant; lifecycle and updates stay on the CLI"
            : `${provider.appId}${provider.url ? ` · ${provider.url}` : " · no reachable URL"}${provider.running ? "" : " · stopped"}`}
        </div>
      </div>

      <Select
        value={autoAllow ? "auto" : "ask"}
        // Meaningless while the app cannot be reached at all, or on a harness that never asks.
        disabled={!enabled || busy || !autoAllowSupported}
        onValueChange={(value) => onApprovalChange(value === "auto")}
      >
        <SelectTrigger
          size="sm"
          className="min-w-0 flex-1 sm:flex-none"
          aria-label={`Approval for ${name}`}
          title={approvalTitle}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value="ask">Ask before every tool</SelectItem>
            <SelectItem value="auto">Run read-only tools unprompted</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
      <Switch
        checked={enabled}
        disabled={busy}
        aria-label={`Let the assistant use ${name}'s tools`}
        onCheckedChange={onToggle}
      />
    </div>
  );
}
