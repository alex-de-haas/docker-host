"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { remarkSoftBreaks, transformChatUrl } from "@/lib/markdown";
import { cn } from "@/lib/utils";

// Assistant prose, rendered the way Marketplace renders an app description
// (`apps/marketplace/src/components/markdown-description.tsx`): react-markdown with remark-gfm, and
// prose styling expressed as arbitrary descendant selectors so the output stays on the shell's
// design tokens without a typography plugin. Sizing is the chat's own — this is a narrow panel, and
// a heading that shouts is worse than one that is merely legible.

const PROSE_CLASS = [
  "text-sm leading-relaxed break-words",
  "[&>:first-child]:mt-0 [&>:last-child]:mb-0",
  "[&_p]:my-2",
  "[&_a]:underline [&_a]:underline-offset-2 [&_a:hover]:text-primary",
  "[&_strong]:font-semibold",
  "[&_h4]:mt-3 [&_h4]:mb-1 [&_h4]:text-base [&_h4]:font-semibold",
  "[&_h5]:mt-3 [&_h5]:mb-1 [&_h5]:font-semibold",
  "[&_h6]:mt-3 [&_h6]:mb-1 [&_h6]:font-medium",
  "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1",
  "[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-muted-foreground/40 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground",
  "[&_code]:rounded [&_code]:bg-background/70 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs",
  "[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:bg-background/60 [&_pre]:p-2 [&_pre]:text-xs",
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
  "[&_hr]:my-3 [&_hr]:border-muted-foreground/30",
  "[&_table]:w-full [&_table]:border-collapse [&_table]:text-xs",
  "[&_th]:border-b [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-medium",
  "[&_td]:border-b [&_td]:border-muted-foreground/15 [&_td]:px-2 [&_td]:py-1",
].join(" ");

export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn(PROSE_CLASS, className)}>
      <ReactMarkdown
        // Soft breaks after GFM, so a table's own line endings are already structured by the time
        // stray newlines become line breaks.
        remarkPlugins={[remarkGfm, remarkSoftBreaks]}
        urlTransform={transformChatUrl}
        components={{
          // A document heading inside a chat bubble is a size, not a rank: the panel's own headings
          // outrank anything the assistant writes, so h1-h3 land where they read as emphasis.
          h1: ({ children }) => <h4>{children}</h4>,
          h2: ({ children }) => <h4>{children}</h4>,
          h3: ({ children }) => <h5>{children}</h5>,
          a: ({ href, children }) =>
            href ? (
              // The panel is embedded in Shell; a link that replaced it would take the operator's
              // session and their unsent draft with it. `noreferrer` keeps the host's URL off the
              // destination.
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ) : (
              // `transformChatUrl` refused the target. An anchor with an empty href is still
              // clickable and resolves to the panel's own URL, so a refused link would open the
              // session in a new tab — the one thing this policy exists to prevent. It is rendered
              // as the text it always was instead, which the operator can still read.
              <>{children}</>
            ),
          // The panel is narrow and a table is as wide as its content: scrolling the table beats
          // wrapping every cell into an unreadable column.
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto">
              <table>{children}</table>
            </div>
          ),
          // Shown as a link rather than fetched. Marketplace loads images because a catalog it
          // already trusts serves them; a transcript's image url is a string an agent produced, and
          // rendering it would have the panel call out to wherever that points.
          img: ({ src, alt }) => {
            const href = typeof src === "string" ? transformChatUrl(src) : "";
            return href ? (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {alt || href}
              </a>
            ) : (
              <>{alt ?? ""}</>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
