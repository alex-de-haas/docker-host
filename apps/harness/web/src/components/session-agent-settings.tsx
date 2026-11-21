"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Loader2, Brain } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { SessionContextDialog } from "./session-context-dialog";
import { SessionModelFields, useSessionModel } from "./session-model";
import { SessionProfileField, useSessionProfile } from "./session-profile";
import { SessionProviderField, useSessionProvider } from "./session-provider";
import type { AssistantSession } from "@/lib/assistant-api";

export type AgentSettingsNotice = { sessionId: string; text: string | null };

type AgentSettingsProps = {
  catalogRefresh?: number; session: AssistantSession; busy: boolean; onChange(record: AssistantSession): void;
  onSavingChange(saving: boolean): void; onNoticeChange(notice: AgentSettingsNotice): void;
};

export function SessionAgentSettings(props: AgentSettingsProps) {
  const [open, setOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [confirmedRevision, setConfirmedRevision] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  return <><AgentSettingsPanel key={JSON.stringify([props.session.connectionId, props.session.connectionRevision])}
    {...props} catalogRefresh={(props.catalogRefresh ?? 0) + confirmedRevision} open={open} setOpen={setOpen} trigger={trigger} onContext={() => { setOpen(false); setContextOpen(true); }} />
    {contextOpen && <SessionContextDialog {...props} onChange={record => { setConfirmedRevision(n => n + 1); props.onChange(record); }} onClose={() => setContextOpen(false)} focusTrigger={() => trigger.current?.focus()} />}
  </>;
}

function AgentSettingsPanel({ session, busy, onChange, onSavingChange, onNoticeChange, open, setOpen, trigger, onContext, catalogRefresh }: AgentSettingsProps & {
  open: boolean; setOpen(open: boolean): void; trigger: React.RefObject<HTMLButtonElement | null>; onContext(): void;
}) {
  const titleId = useId();
  const props = { session, busy, onChange, onSavingChange };
  // Keep controllers alive while the panel is closed: default adoption and recovery still run,
  // and closing the panel during a save must not discard its confirmed result or Send interlock.
  const provider = useSessionProvider({ ...props, enabled: session.providerLocked !== undefined });
  const profile = useSessionProfile({ ...props, enabled: session.profileLocked !== undefined });
  const model = useSessionModel({ ...props, catalogRefresh });
  const saving = provider.saving || profile.saving || model.saving;
  const summary = session.connectionId ? `${model.modelLabel} · ${model.effortLabel}` : "Choose provider";
  const notice = provider.notice || profile.error || model.error || model.catalogError || null;
  useEffect(() => { onNoticeChange({ sessionId: session.id, text: open ? null : notice }); }, [session.id, notice, open, onNoticeChange]);

  return <Popover open={open} onOpenChange={setOpen}>
    <TooltipProvider delayDuration={250}><Tooltip>
      <TooltipTrigger asChild><PopoverTrigger asChild>
        <Button ref={trigger} type="button" size="icon" variant="ghost" className="w-auto h-9 min-w-9 max-w-full shrink gap-2 px-2.5 @min-[440px]/composer:px-2"
          aria-label={`Agent settings: ${summary}`}>
          {saving ? <Loader2 data-icon="inline-start" className="motion-safe:animate-spin" /> : <Brain data-icon="inline-start" />}
          <span className="hidden min-w-0 truncate @min-[440px]/composer:inline">{summary}</span>
          {saving && <span role="status" className="sr-only">Saving agent settings…</span>}
        </Button>
      </PopoverTrigger></TooltipTrigger>
      <TooltipContent><p>{summary}</p></TooltipContent>
    </Tooltip></TooltipProvider>
    <PopoverContent side="top" align="start" sideOffset={8} collisionPadding={12} aria-labelledby={titleId}
      className="flex max-h-[min(36rem,var(--radix-popover-content-available-height))] w-80 max-w-[calc(100vw-1.5rem)] flex-col gap-4 overflow-y-auto">
      <PopoverHeader><PopoverTitle id={titleId}>Agent settings</PopoverTitle></PopoverHeader>
      <FieldGroup className="gap-4">
        {session.profileLocked !== undefined && <SessionProfileField controller={profile} />}
        {session.providerLocked !== undefined && <SessionProviderField controller={provider} />}
        {session.connectionId && <SessionModelFields controller={model} />}
        {session.providerLocked && session.connectionId && !session.taskExecutionId &&
          <Button type="button" variant="outline" disabled={busy || saving} onClick={onContext}>Change session context…</Button>}
      </FieldGroup>
    </PopoverContent>
  </Popover>;
}
