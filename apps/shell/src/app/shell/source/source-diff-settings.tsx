"use client";

import { useId } from "react";
import { Label } from "@/components/ui/label";
import { AlignLeft, ChevronDown, Columns2, ListOrdered, Rows2, WrapText } from "lucide-react";
import type { FileDiffOptions } from "@pierre/diffs/react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

const separatorLabels = { "line-info-basic": "Line Info Basic", "line-info": "Line Info", metadata: "Metadata", simple: "Simple" } as const;

export type SourceDiffSettings = Required<Pick<FileDiffOptions<undefined, undefined>,
  "diffStyle" | "diffIndicators" | "lineDiffType" | "disableBackground" | "disableLineNumbers" | "overflow">> & {
  hunkSeparators: keyof typeof separatorLabels;
};

export const defaultSourceDiffSettings: SourceDiffSettings = {
  diffStyle: "unified",
  diffIndicators: "bars",
  lineDiffType: "word-alt",
  hunkSeparators: "line-info-basic",
  disableBackground: false,
  disableLineNumbers: false,
  overflow: "wrap",
};

const lineDiffLabels = { "word-alt": "Word-Alt", word: "Word", char: "Character", none: "None" } as const;

export function SourceDiffToolbar({ settings, onChange }: {
  settings: SourceDiffSettings;
  onChange: (settings: SourceDiffSettings) => void;
}) {
  const id = useId();
  const update = (patch: Partial<SourceDiffSettings>) => onChange({ ...settings, ...patch });
  return <div role="group" aria-label="Diff display settings" className="flex flex-wrap items-center gap-2">
    <div role="group" aria-label="Diff layout" className="flex gap-0.5 rounded-md bg-muted p-0.5">
      <Button size="sm" variant={settings.diffStyle === "unified" ? "outline" : "ghost"} aria-pressed={settings.diffStyle === "unified"} onClick={() => update({ diffStyle: "unified" })}><Rows2 />Unified</Button>
      <Button size="sm" variant={settings.diffStyle === "split" ? "outline" : "ghost"} aria-pressed={settings.diffStyle === "split"} onClick={() => update({ diffStyle: "split" })}><Columns2 />Split</Button>
    </div>
    <div role="group" aria-label="Change markers" className="flex gap-0.5 rounded-md bg-muted p-0.5">
      {(["bars", "classic", "none"] as const).map((value) => <Button key={value} size="sm" variant={settings.diffIndicators === value ? "outline" : "ghost"} aria-pressed={settings.diffIndicators === value} onClick={() => update({ diffIndicators: value })}>
        {value === "bars" ? "Bars" : value === "classic" ? "Classic" : "None"}
      </Button>)}
    </div>
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button size="sm" variant="outline" aria-label={`Inline highlighting: ${lineDiffLabels[settings.lineDiffType]}`}>{lineDiffLabels[settings.lineDiffType]}<ChevronDown /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup value={settings.lineDiffType} onValueChange={(value) => {
          if (value === "word-alt" || value === "word" || value === "char" || value === "none") update({ lineDiffType: value });
        }}>
          {Object.entries(lineDiffLabels).map(([value, label]) => <DropdownMenuRadioItem key={value} value={value}>{label}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button size="sm" variant="outline" aria-label={`Unchanged lines: ${separatorLabels[settings.hunkSeparators]}`}>{separatorLabels[settings.hunkSeparators]}<ChevronDown /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup value={settings.hunkSeparators} onValueChange={(value) => {
          if (value === "line-info-basic" || value === "line-info" || value === "metadata" || value === "simple") update({ hunkSeparators: value });
        }}>
          {Object.entries(separatorLabels).map(([value, label]) => <DropdownMenuRadioItem key={value} value={value}>{label}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
    <div className="flex h-8 items-center gap-2 rounded-md border bg-background px-2.5 text-sm shadow-xs"><Label htmlFor={`${id}-backgrounds`} className="cursor-pointer gap-2"><AlignLeft className="size-4" />Backgrounds</Label><Switch id={`${id}-backgrounds`} size="sm" aria-label="Diff backgrounds" checked={!settings.disableBackground} onCheckedChange={(checked) => update({ disableBackground: !checked })} /></div>
    <div className="flex h-8 items-center gap-2 rounded-md border bg-background px-2.5 text-sm shadow-xs"><Label htmlFor={`${id}-wrapping`} className="cursor-pointer gap-2"><WrapText className="size-4" />Wrapping</Label><Switch id={`${id}-wrapping`} size="sm" aria-label="Wrap diff lines" checked={settings.overflow === "wrap"} onCheckedChange={(checked) => update({ overflow: checked ? "wrap" : "scroll" })} /></div>
    <div className="flex h-8 items-center gap-2 rounded-md border bg-background px-2.5 text-sm shadow-xs"><Label htmlFor={`${id}-numbers`} className="cursor-pointer gap-2"><ListOrdered className="size-4" />Line numbers</Label><Switch id={`${id}-numbers`} size="sm" aria-label="Diff line numbers" checked={!settings.disableLineNumbers} onCheckedChange={(checked) => update({ disableLineNumbers: !checked })} /></div>
  </div>;
}
