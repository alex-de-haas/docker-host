"use client";

import { useId } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Separator } from "@/components/ui/separator";
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
  multipleConnections = false,
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
  multipleConnections?: boolean;
  onToggle: (next: boolean) => void;
  onApprovalChange: (autoAllow: boolean) => void;
}) {
  const id = useId();
  const name = provider.displayName || provider.appId;
  const isCore = provider.appId === CORE_PROVIDER_ID;

  // Three different things the select can be saying, and the tooltip has to say the right one: the
  // harness ignores it, Core's own annotations are being trusted, or an app's word is.
  const approvalTitle = !autoAllowSupported
    ? `The ${harnessName} harness decides on its own which calls pause; this choice has no effect there.`
    : isCore
      ? "Core annotates its own tools, so running the read-only ones unprompted trusts the platform rather than a third party. Lifecycle and updates stay on the CLI."
      : "The app declares which of its tools are read-only. Choosing to run them unprompted means trusting that declaration: a tool the app mislabels would then run without asking you.";

  return (
    <Card className="gap-0 overflow-hidden py-0 shadow-none">
      <CardHeader className="bg-muted/40 px-5 py-4">
        <CardTitle>Access &amp; approvals</CardTitle>
      </CardHeader>
      <CardContent className="border-t p-0">
        <FieldGroup className="gap-0">
          <Field orientation="horizontal" className="p-5">
            <FieldContent>
              <FieldLabel htmlFor={`${id}-access`}>Allow access</FieldLabel>
              <FieldDescription id={`${id}-access-description`}>
                Make this application&apos;s tools available to the assistant.
              </FieldDescription>
            </FieldContent>
            <Switch
              id={`${id}-access`}
              checked={enabled}
              disabled={busy}
              aria-label={`Let the assistant use ${name}'s tools`}
              aria-describedby={`${id}-access-description`}
              onCheckedChange={onToggle}
            />
          </Field>
          <Separator />
          <Field orientation="responsive" className="p-5" data-disabled={!enabled || busy || !autoAllowSupported}>
            <FieldContent className="min-w-0">
              <FieldLabel htmlFor={`${id}-approval`}>Tool approvals</FieldLabel>
              <FieldDescription id={`${id}-approval-description`}>
                Choose when to ask for confirmation.
              </FieldDescription>
            </FieldContent>
            <Select
              value={autoAllow ? "auto" : "ask"}
              disabled={!enabled || busy || !autoAllowSupported}
              onValueChange={(value) => onApprovalChange(value === "auto")}
            >
              <SelectTrigger
                id={`${id}-approval`}
                className="w-full min-w-0 @md/field-group:basis-72 @md/field-group:shrink-0"
                aria-label={`Approval for ${name}`}
                aria-describedby={`${id}-approval-description`}
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
          </Field>
        </FieldGroup>
        <div className="flex flex-col gap-2 border-t bg-muted/40 px-5 py-4 text-sm text-muted-foreground">
          {multipleConnections && <p>Claude uses these approval modes. Codex follows its own approval rules. Live changes apply where the chat&apos;s provider supports them.</p>}
          {!autoAllowSupported && <p>The {harnessName} harness decides which calls pause; this approval setting has no effect on it.</p>}
          <p>{isCore
            ? "Core exposes read-only tools to the assistant. Lifecycle and updates stay on the CLI."
            : "Read-only mode trusts this application's tool annotations. New applications start with access off."}</p>
          {!isCore && <p className="break-all text-xs">{provider.url ?? "No reachable URL"}{provider.running ? "" : " · Application stopped"}</p>}
        </div>
      </CardContent>
    </Card>
  );
}
