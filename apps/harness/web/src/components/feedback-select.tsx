"use client";

import { useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

type FeedbackOption = { value: string; label: string; disabled?: boolean };
type FeedbackSelectProps = {
  label: string; value: string; onValueChange(value: string): void;
  options: readonly FeedbackOption[]; disabled?: boolean; className?: string; placeholder?: string;
};

/** All values are encoded, including empty defaults and opaque IDs resembling menu sentinels. */
export function FeedbackSelect({ label, value, onValueChange, options, disabled = false, className, placeholder }: FeedbackSelectProps) {
  const [menu, setMenu] = useState({ open: false, disabled });
  // Reset an open portaled menu when its control becomes busy, without reopening it afterwards.
  if (menu.disabled !== disabled) setMenu({ open: false, disabled });
  const selected = options.find(option => option.value === value);
  const encode = (raw: string) => "value:" + raw;
  return <Select value={encode(value)} disabled={disabled} open={menu.open && !disabled && menu.disabled === disabled}
    onOpenChange={open => setMenu({ open: !disabled && open, disabled })}
    onValueChange={encoded => {
      if (disabled || !encoded.startsWith("value:")) return;
      const raw = encoded.slice(6), option = options.find(item => item.value === raw);
      if (option && !option.disabled) onValueChange(raw);
    }}>
    <SelectTrigger aria-label={label} className={className ? "w-full " + className : "w-full"}>
      <SelectValue>{selected?.label ?? placeholder ?? "Unavailable selection"}</SelectValue>
    </SelectTrigger>
    <SelectContent position="popper" align="start" className="w-(--radix-select-trigger-width) max-h-[min(18rem,var(--radix-select-content-available-height))]">
      {!selected && <SelectItem value={encode(value)} disabled>{placeholder ?? "Unavailable selection"}</SelectItem>}
      {options.map(option => <SelectItem key={option.value} value={encode(option.value)} disabled={disabled || option.disabled}>
        <span className="min-w-0 whitespace-normal wrap-anywhere">{option.label}</span>
      </SelectItem>)}
    </SelectContent>
  </Select>;
}
