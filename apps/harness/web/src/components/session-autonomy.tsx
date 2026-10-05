"use client";

import { useRef, useState } from "react";
import { ChevronDown, Loader2, Shield, ShieldAlert } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { setSessionAutonomy, type AssistantSession } from "@/lib/assistant-api";

export function SessionAutonomy({ session, busy, onChange, onSavingChange }: {
  session: AssistantSession;
  busy: boolean;
  onChange(record: AssistantSession): void;
  onSavingChange(saving: boolean): void;
}) {
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState("");
  const autonomous = session.autonomy === "autonomous";
  const active = ["running", "awaiting_approval", "awaiting_question"].includes(session.status);
  const save = async (value: string) => {
    if (savingRef.current || busy || active || value !== "normal" && value !== "autonomous") return;
    savingRef.current = true; setSaving(true); onSavingChange(true); setError("");
    try { onChange(await setSessionAutonomy(session.id, value)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not change autonomy."); }
    finally { savingRef.current = false; setSaving(false); onSavingChange(false); }
  };
  const Icon = autonomous ? ShieldAlert : Shield;
  return <div className="flex min-w-0 flex-col text-xs">
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" className="h-9 gap-1.5 px-2" disabled={busy || saving || active}
          aria-label={`Autonomy: ${autonomous ? "Autonomous" : "Normal"}`}
          title={active ? "Stop the current run before changing autonomy." : "Approval mode for this chat"}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : <Icon className="size-4" />}
          {autonomous ? "Autonomous" : "Normal"}<ChevronDown className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-80">
        <DropdownMenuRadioGroup value={autonomous ? "autonomous" : "normal"} onValueChange={value => void save(value)}>
          <DropdownMenuRadioItem value="normal"><div>Normal<p className="mt-1 text-xs text-muted-foreground">Use tool rules; ask for other actions.</p></div></DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="autonomous"><div>Autonomous<p className="mt-1 text-xs text-muted-foreground">Commands, file changes and enabled MCP tools without approval. Access follows the Harness process permissions. Disabled MCP tools stay disabled.</p></div></DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
    {error && <span role="alert" className="max-w-80 text-destructive">{error}</span>}
  </div>;
}
