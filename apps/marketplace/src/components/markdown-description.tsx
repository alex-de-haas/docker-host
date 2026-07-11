"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  isSameMarkdownOrigin,
  safeMarkdownBase,
  transformMarkdownUrl,
} from "@/lib/markdown-urls";

// Prose styling is expressed with arbitrary descendant selectors so the rendered markdown stays on
// the shell's design tokens (border-border, bg-muted, text-foreground/-muted) without pulling in a
// typography plugin the shell does not use.
const PROSE_CLASS = [
  "rounded-md border bg-muted/30 p-4 text-sm leading-relaxed text-muted-foreground",
  "[&_>_:first-child]:mt-0 [&_>_:last-child]:mb-0",
  "[&_p]:my-2",
  "[&_a]:font-medium [&_a]:text-foreground [&_a]:underline [&_a]:underline-offset-2",
  "[&_strong]:font-semibold [&_strong]:text-foreground",
  "[&_h3]:mt-4 [&_h3]:mb-1 [&_h3]:font-semibold [&_h3]:text-foreground",
  "[&_h4]:mt-4 [&_h4]:mb-1 [&_h4]:font-semibold [&_h4]:text-foreground",
  "[&_h5]:mt-3 [&_h5]:mb-1 [&_h5]:font-medium [&_h5]:text-foreground",
  "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1",
  "[&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3",
  "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs",
  "[&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0",
  "[&_img]:my-3 [&_img]:max-w-full [&_img]:rounded-md [&_img]:border [&_hr]:my-4 [&_hr]:border-border",
  "[&_table]:w-full [&_table]:border-collapse [&_table]:text-xs",
  "[&_th]:border [&_th]:border-border [&_th]:bg-muted [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:text-foreground",
  "[&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1",
].join(" ");

export function MarkdownDescription({ content, sourceUrl }: { content: string; sourceUrl: string }) {
  const base = safeMarkdownBase(sourceUrl);

  return (
    <section className={PROSE_CLASS} aria-label="App description">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={value => transformMarkdownUrl(value, base)}
        components={{
          h1: ({ children }) => <h3>{children}</h3>,
          h2: ({ children }) => <h4>{children}</h4>,
          h3: ({ children }) => <h5>{children}</h5>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
          ),
          table: ({ children }) => <div className="my-3 overflow-x-auto"><table>{children}</table></div>,
          img: ({ src, alt }) => {
            if (typeof src !== "string" || !src || !base) {
              return null;
            }
            if (isSameMarkdownOrigin(src, base)) {
              // eslint-disable-next-line @next/next/no-img-element -- catalog-owned remote asset
              return <img src={src} alt={alt ?? ""} loading="lazy" />;
            }
            return <a href={src} target="_blank" rel="noopener noreferrer">{alt || src}</a>;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </section>
  );
}
