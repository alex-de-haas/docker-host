"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { PromptTemplate } from "@/lib/prompt-templates-api";
import type { usePromptTemplatePicker } from "@/lib/use-prompt-template-picker";

export function PromptTemplateOptions({ picker, listId, search, onSearch, onChoose }: {
  picker: ReturnType<typeof usePromptTemplatePicker>; listId: string;
  search?: string; onSearch: (value: string) => void; onChoose: (template: PromptTemplate) => void;
}) {
  return <>
    <p className="px-2 pb-2 text-sm font-medium">Prompt templates</p>
    {search !== undefined && <Input aria-label="Search prompt templates" placeholder="Search by title or shortcut" value={search}
      className="mb-2" onChange={event => onSearch(event.target.value)} aria-controls={listId} aria-autocomplete="list"
      aria-expanded="true" aria-activedescendant={picker.templates[picker.active] ? `${listId}-template-${picker.active}` : undefined} />}
    <div id={listId} role="listbox" aria-label="Prompt templates" aria-busy={picker.loading} className="max-h-60 overflow-y-auto">
      {picker.templates.map((template, index) => <button key={template.id} id={`${listId}-template-${index}`} type="button" role="option" tabIndex={-1}
        aria-selected={index === picker.active} className={cn("block w-full rounded-md p-2 text-left", index === picker.active && "bg-accent")}
        onMouseDown={event => event.preventDefault()} onMouseEnter={() => picker.setActive(index)} onClick={() => onChoose(template)}>
        <span className="flex items-start justify-between gap-2 text-sm"><span className="min-w-0 break-words">{template.name}</span>
          <span className="shrink-0 font-mono text-xs text-muted-foreground">!{template.shortcut}</span></span>
        <span className="mt-1 block truncate text-xs text-muted-foreground">{template.text}</span>
      </button>)}
    </div>
    {picker.loading && <p role="status" className="p-2 text-xs text-muted-foreground">Loading templates…</p>}
    {!picker.loading && !picker.error && !picker.templates.length && <p role="status" className="p-2 text-xs text-muted-foreground">
      {picker.empty ? "No prompt templates yet. Create one in settings, then type ! and its shortcut." : "No matching templates. Escape keeps your text."}</p>}
    {picker.error && <div className="p-2"><p role="alert" className="text-xs text-destructive-foreground">{picker.error}</p>
      <Button type="button" variant="ghost" size="sm" onClick={picker.retry}>Retry templates</Button></div>}
    <a href="/settings/templates" className="block rounded-md px-2 py-2 text-sm underline underline-offset-4">Manage prompt templates</a>
  </>;
}
