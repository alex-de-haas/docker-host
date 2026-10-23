"use client";

import {
  CodeBlock,
  CodeBlockCopyButton,
  CodeBlockExpandButton,
  CodeBlockHeader,
  CodeBlockTitle,
  CodeBlockWrapToggle,
} from "@/components/reui/code-block/code-block";

/** Shared presentation for markdown fences and tool payloads in the narrow assistant panel. */
export function ChatCodeBlock({ code, language, title, streaming = false, tone = "default" }: {
  code: string;
  language?: string;
  title?: string;
  streaming?: boolean;
  tone?: "default" | "ink";
}) {
  const block = (
    <CodeBlock code={code} language={language} streaming={streaming} maxLines={12}
      label={title ?? language ?? "Code"} className="my-2 min-w-0 max-w-full">
      <CodeBlockHeader>
        <CodeBlockTitle>{title ?? language ?? "Code"}</CodeBlockTitle>
        <CodeBlockWrapToggle size="sm" />
        <CodeBlockCopyButton value={code} />
      </CodeBlockHeader>
      <CodeBlockExpandButton />
    </CodeBlock>
  );
  return tone === "ink" ? <div className="dark rounded-lg px-2 [--card:#0f1b2d] [--card-foreground:#f3f5f7] [--border:#32415a] [--muted-foreground:#b5c0d1] bg-[#0f1b2d]">{block}</div> : block;
}
