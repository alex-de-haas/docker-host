"use client";
import type { ReactNode } from "react";
import { ExternalLink, Ellipsis, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";

export function ShellToolPanel({ title, label = title, children, onHide, onEnd, onAllTools, standaloneHref }: {
  title: string; label?: string; children: ReactNode; onHide: () => void; onEnd?: () => void; onAllTools: () => void; standaloneHref?: string | null;
}) {
  return <aside aria-label={label} className="flex h-full min-h-0 min-w-0 flex-col bg-background">
    <header className="flex h-11 shrink-0 items-center gap-1 border-b px-3">
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
      <Button variant="ghost" size="sm" onClick={onAllTools}>All tools</Button>
      {standaloneHref && <Button variant="ghost" size="icon" asChild><a href={standaloneHref} target="_blank" rel="noopener noreferrer" aria-label="Open separately" title="Open separately"><ExternalLink /></a></Button>}
      {onEnd && <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label="Tool actions"><Ellipsis /></Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onSelect={onEnd}>End this tool view</DropdownMenuItem></DropdownMenuContent></DropdownMenu>}
      <Button variant="ghost" size="icon" aria-label={label === "Feedback draft" ? "Close feedback" : "Hide tool"} title="Hide tool" onClick={onHide}><X /></Button>
    </header>
    {children}
  </aside>;
}
