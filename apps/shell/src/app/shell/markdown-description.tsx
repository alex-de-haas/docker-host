"use client";

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

// Renders an app's manifest-declared markdown long-description (manifest-level app assets) fetched from
// `src` — a Core asset URL for an installed app, or the vendored catalog URL on the storefront. The
// markdown is rendered with GFM support and no raw-HTML pass-through (react-markdown's default), so it is
// safe by construction. Relative image/link refs resolve against the document's own folder; javascript:
// and data: URLs are dropped, and an image hosted on a different origin than the document renders as a
// link rather than being inlined (no third-party hotloading — mirrors the publish-time boundary).
export function MarkdownDescription({ src, className }: { src: string; className?: string }) {
  // State carries the src it belongs to; while a new src's fetch is in flight the stale/old state's src
  // no longer matches and the component renders nothing. All setState happens in async callbacks (never
  // synchronously in the effect body), so there is no reset-render on every src change.
  const [state, setState] = useState<{ src: string; error: boolean; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(src, { credentials: "include" })
      .then((response) => (response.ok ? response.text() : Promise.reject(new Error(String(response.status)))))
      .then((text) => {
        if (!cancelled) setState({ src, error: false, text });
      })
      .catch(() => {
        if (!cancelled) setState({ src, error: true, text: "" });
      });
    return () => {
      cancelled = true;
    };
  }, [src]);

  // Resolve refs against the document's own folder. A blank result drops the ref (react-markdown then
  // renders no href/src), which is how we neutralize javascript:/data: and unresolvable URLs.
  const base = safeBase(src);
  const transformUrl = (url: string): string => {
    if (url.startsWith("#")) {
      return url;
    }
    if (!base) {
      return "";
    }
    try {
      const resolved = new URL(url, base);
      return resolved.protocol === "http:" || resolved.protocol === "https:" ? resolved.href : "";
    } catch {
      return "";
    }
  };

  if (!state || state.src !== src || state.error || state.text.trim().length === 0) {
    return null;
  }

  return (
    <div className={cn("space-y-2 text-sm leading-relaxed text-foreground/90", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={transformUrl}
        components={{
          h1: ({ children }) => <h3 className="mt-3 text-base font-semibold">{children}</h3>,
          h2: ({ children }) => <h4 className="mt-3 text-sm font-semibold">{children}</h4>,
          h3: ({ children }) => <h5 className="mt-2 text-sm font-semibold">{children}</h5>,
          p: ({ children }) => <p className="my-2">{children}</p>,
          ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
          li: ({ children }) => <li className="pl-0.5">{children}</li>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">
              {children}
            </a>
          ),
          code: ({ children }) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{children}</code>,
          pre: ({ children }) => <pre className="my-2 overflow-x-auto rounded-md bg-muted p-3 text-xs">{children}</pre>,
          blockquote: ({ children }) => <blockquote className="my-2 border-l-2 pl-3 text-muted-foreground">{children}</blockquote>,
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto">
              <table className="w-full border-collapse text-xs">{children}</table>
            </div>
          ),
          th: ({ children }) => <th className="border px-2 py-1 text-left font-medium">{children}</th>,
          td: ({ children }) => <td className="border px-2 py-1">{children}</td>,
          img: ({ src: imageSrc, alt }) => {
            // urlTransform already resolved/sanitized the src; only inline images from the document's own
            // origin. Anything cross-origin is shown as a link so the storefront never hotloads it.
            if (typeof imageSrc !== "string" || imageSrc.length === 0) {
              return null;
            }
            if (base && sameOrigin(imageSrc, base)) {
              // eslint-disable-next-line @next/next/no-img-element -- app-served asset, not a Next static image
              return <img src={imageSrc} alt={alt ?? ""} loading="lazy" className="my-2 max-w-full rounded-md border" />;
            }
            return (
              <a href={imageSrc} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">
                {alt || imageSrc}
              </a>
            );
          },
        }}
      >
        {state.text}
      </ReactMarkdown>
    </div>
  );
}

function safeBase(src: string): URL | null {
  try {
    return new URL(".", src);
  } catch {
    return null;
  }
}

function sameOrigin(url: string, base: URL): boolean {
  try {
    return new URL(url).origin === base.origin;
  } catch {
    return false;
  }
}
