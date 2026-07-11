"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  isSameMarkdownOrigin,
  safeMarkdownBase,
  transformMarkdownUrl,
} from "@/lib/markdown-urls";

export function MarkdownDescription({ content, sourceUrl }: { content: string; sourceUrl: string }) {
  const base = safeMarkdownBase(sourceUrl);

  return (
    <section className="description" aria-label="App description">
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
          code: ({ children }) => <code>{children}</code>,
          pre: ({ children }) => <pre>{children}</pre>,
          blockquote: ({ children }) => <blockquote>{children}</blockquote>,
          table: ({ children }) => <div className="description-table"><table>{children}</table></div>,
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
