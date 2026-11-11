"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Markdown } from "./markdown";
import { Button } from "./ui/button";
import { useMessageReadingPosition } from "./ui/message-scroller";

/** Measure rendered content so wrapped prose uses the same preview budget as explicit newlines. */
export function UserMessage({ text }: { text: string }) {
  const id = useId();
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const readMessage = useMessageReadingPosition();
  // Keep links, focus and code-block state intact while only the viewport changes.
  const markdown = useMemo(() => <Markdown text={text} />, [text]);

  useEffect(() => {
    const frame = viewport.current;
    const body = content.current;
    if (!frame || !body) return;
    const measure = () => {
      const lineHeight = Number.parseFloat(getComputedStyle(frame).lineHeight);
      setOverflowing(body.getBoundingClientRect().height > lineHeight * 5 + 1);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(frame);
    observer?.observe(body);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [text]);

  const collapsed = overflowing && !expanded;
  return <div className="ml-3 min-w-0 rounded-lg bg-primary/10 px-3 py-2 sm:ml-8" data-slot="user-message">
    <div id={id} ref={viewport} className="overflow-hidden text-sm" style={{ maxHeight: expanded ? undefined : "5lh" }}
      // Reveal interactive Markdown when keyboard focus enters the preview.
      onFocusCapture={event => { if (collapsed) { readMessage(event.currentTarget); setExpanded(true); } }}>
      <div ref={content} className="flow-root">{markdown}</div>
    </div>
    {overflowing && <Button type="button" variant="ghost" size="sm" aria-expanded={expanded} aria-controls={id}
      className="mt-1 h-auto min-h-7 gap-1 px-1 py-1 text-xs text-muted-foreground hover:text-foreground"
      onClick={event => { readMessage(event.currentTarget); setExpanded(value => !value); }}>
      {expanded ? "Show less" : "Show more"}
      {expanded ? <ChevronUp className="size-3" aria-hidden /> : <ChevronDown className="size-3" aria-hidden />}
    </Button>}
  </div>;
}
