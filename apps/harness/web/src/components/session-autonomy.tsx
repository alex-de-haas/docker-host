"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Shield, ShieldAlert } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { setSessionAutonomy, type AssistantSession } from "@/lib/assistant-api";

export function SessionAutonomy({ session, busy, onChange, onSavingChange, onErrorChange }: {
  session: AssistantSession;
  busy: boolean;
  onChange(record: AssistantSession): void;
  onSavingChange(saving: boolean): void;
  onErrorChange?(notice: { sessionId: string; text: string | null }): void;
}) {
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState("");
  useEffect(() => { onErrorChange?.({ sessionId: session.id, text: error || null }); }, [session.id, error, onErrorChange]);
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
  return <div className="flex shrink-0 flex-col text-xs">
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon" disabled={busy || saving || active}
          aria-label={`Autonomy: ${autonomous ? "Autonomous" : "Normal"}`}
          title={active ? "Stop the current run before changing autonomy." : `Autonomy: ${autonomous ? "Autonomous" : "Normal"}`}>
          {saving ? <Loader2 aria-hidden="true" className="size-4 motion-safe:animate-spin" /> : <Icon aria-hidden="true" className="size-4" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-80 max-w-[calc(100vw-1.5rem)]">
        <DropdownMenuRadioGroup value={autonomous ? "autonomous" : "normal"} onValueChange={value => void save(value)}>
          <DropdownMenuRadioItem value="normal"><div><span className="flex items-center gap-2"><Shield aria-hidden="true" className="size-4" />Normal</span><p className="mt-1 text-xs text-muted-foreground">Use tool rules; ask for other actions.</p></div></DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="autonomous"><div><span className="flex items-center gap-2"><ShieldAlert aria-hidden="true" className="size-4" />Autonomous</span><p className="mt-1 text-xs text-muted-foreground">Commands, file changes and enabled MCP tools without approval. {session.executionMode === "docker" ? "Commands run within the shared Docker worker." : "Access follows the native Harness process permissions."} Disabled MCP tools stay disabled.</p></div></DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
    {error && !onErrorChange && <span role="alert" className="max-w-full text-destructive-foreground wrap-anywhere">{error}</span>}
  </div>;
}
