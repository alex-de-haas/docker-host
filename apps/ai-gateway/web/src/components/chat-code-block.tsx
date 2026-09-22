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
export function ChatCodeBlock({ code, language, title, streaming = false }: {
  code: string;
  language?: string;
  title?: string;
  streaming?: boolean;
}) {
  return (
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
}
