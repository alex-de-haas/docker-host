"use client";
import { headings } from "../../../../scripts/docs-format.mjs";
import { useEffect, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { DeliverableSummary } from "./plan-metadata";
import { markdownTarget } from "@/lib/markdown";
import { planLink } from "@/lib/model";
import type { ParsedDocument } from "@/lib/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export function TrackedDocument({
  document,
  error,
  repositoryId,
  navigate,
  children,
}: {
  document: ParsedDocument | null;
  error: string | null;
  repositoryId: string;
  navigate: (url: string) => void;
  children?: ReactNode;
}) {
  if (error)
    return (
      <Alert variant="destructive">
        <AlertTitle>Tracked branch unavailable</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  return document ? (
    (children ?? (
      <SourceDocument
        document={document}
        repositoryId={repositoryId}
        navigate={navigate}
      />
    ))
  ) : (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>Workspace only</EmptyTitle>
        <EmptyDescription>
          This document exists only in a workspace.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export function SourceDocument({
  document,
  repositoryId,
  navigate,
  body,
  workspaceId,
}: {
  workspaceId?: string | null;
  document: ParsedDocument;
  repositoryId: string;
  navigate: (url: string) => void;
  body?: string;
}) {
  const outline = headings(body ?? document.body);
  const hasOutline = outline.some((item) => item.level > 1 && item.level < 4);
  const hasAside = hasOutline || !!document.backlinks?.length;
  const headingId = (line?: number) =>
    outline.find((item) => item.line === line)?.id;
  useEffect(() => {
    let anchor = window.location.hash.slice(1);
    try {
      anchor = decodeURIComponent(anchor);
    } catch {
      /* Use the literal anchor. */
    }
    if (anchor) globalThis.document.getElementById(anchor)?.scrollIntoView();
  }, [document.path, workspaceId]);
  return (
    <>
      {document.errors.length > 0 && (
        <Alert variant="destructive">
          <AlertTitle>Document needs attention</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">
              {document.errors.map((error, index) => (
                <li key={index}>{error}</li>
              ))}
            </ul>
            <p>Progress is unknown until these errors are resolved.</p>
          </AlertDescription>
        </Alert>
      )}
      <DeliverableSummary document={document} />
      <div className={hasAside ? "document-prose-layout" : undefined}>
        <div className="markdown">
          <ReactMarkdown
            skipHtml
            remarkPlugins={[remarkGfm]}
            urlTransform={(value) => value}
            components={{
              h1: ({ node, children }) => (
                <h1 id={headingId(node?.position?.start.line)}>{children}</h1>
              ),
              h2: ({ node, children }) => (
                <h2 id={headingId(node?.position?.start.line)}>{children}</h2>
              ),
              h3: ({ node, children }) => (
                <h3 id={headingId(node?.position?.start.line)}>{children}</h3>
              ),
              h4: ({ node, children }) => (
                <h4 id={headingId(node?.position?.start.line)}>{children}</h4>
              ),
              h5: ({ node, children }) => (
                <h5 id={headingId(node?.position?.start.line)}>{children}</h5>
              ),
              h6: ({ node, children }) => (
                <h6 id={headingId(node?.position?.start.line)}>{children}</h6>
              ),
              a: ({ href = "", children }) => {
                const target = markdownTarget(document.path, href);
                if (target.kind === "external")
                  return (
                    <a
                      href={target.value}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {children}
                    </a>
                  );
                if (target.kind === "anchor")
                  return <a href={target.value}>{children}</a>;
                if (target.kind === "document")
                  return (
                    <a
                      href={
                        planLink(
                          repositoryId,
                          target.path!,
                          workspaceId ?? undefined,
                        ) +
                        (target.anchor
                          ? `#${encodeURIComponent(target.anchor)}`
                          : "")
                      }
                      onClick={(event) => {
                        if (
                          !event.ctrlKey &&
                          !event.metaKey &&
                          !event.shiftKey
                        ) {
                          event.preventDefault();
                          navigate(
                            planLink(
                              repositoryId,
                              target.path!,
                              workspaceId ?? undefined,
                            ) +
                              (target.anchor
                                ? `#${encodeURIComponent(target.anchor)}`
                                : ""),
                          );
                        }
                      }}
                    >
                      {children}
                    </a>
                  );
                return (
                  <span>
                    {children}{" "}
                    <code className="source-path">({target.value})</code>
                  </span>
                );
              },
              img: ({ src = "", alt = "" }) => {
                const target = markdownTarget(document.path, String(src));
                if (target.kind === "external")
                  return (
                    <a
                      href={target.value}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {alt || "Image"} ({target.value})
                    </a>
                  );
                return (
                  <span className="source-path">
                    {alt || "Image"} ({target.path ?? target.value})
                  </span>
                );
              },
              table: ({ children }) => <Table>{children}</Table>,
              thead: ({ children }) => <TableHeader>{children}</TableHeader>,
              tbody: ({ children }) => <TableBody>{children}</TableBody>,
              tr: ({ children }) => <TableRow>{children}</TableRow>,
              th: ({ children, style }) => (
                <TableHead style={style}>{children}</TableHead>
              ),
              td: ({ children, style }) => (
                <TableCell style={style}>{children}</TableCell>
              ),
            }}
          >
            {body ?? document.body}
          </ReactMarkdown>
        </div>
        {hasAside && (
          <aside className="space-y-5 text-xs text-muted-foreground">
            {hasOutline && (
              <details open>
                <summary className="mb-3 cursor-pointer font-medium text-foreground">
                  On this page
                </summary>
                <nav
                  aria-label="Document contents"
                  className="flex flex-col gap-2"
                >
                  {outline
                    .filter((item) => item.level > 1 && item.level < 4)
                    .map((item) => (
                      <a
                        key={item.id}
                        className="hover:text-foreground hover:underline"
                        href={`#${item.id}`}
                      >
                        {item.text}
                      </a>
                    ))}
                </nav>
              </details>
            )}
            {!!document.backlinks?.length && (
              <section>
                <h3 className="mb-3 font-medium text-foreground">
                  Linked from · {document.backlinks.length}
                </h3>
                <div className="flex flex-col gap-2">
                  {document.backlinks.map((link, index) => (
                    <a
                      key={index}
                      href={planLink(
                        repositoryId,
                        link.path,
                        workspaceId ?? undefined,
                      )}
                      onClick={(event) => {
                        if (!event.metaKey && !event.ctrlKey) {
                          event.preventDefault();
                          navigate(
                            planLink(
                              repositoryId,
                              link.path,
                              workspaceId ?? undefined,
                            ),
                          );
                        }
                      }}
                      className="hover:underline"
                    >
                      {link.title}
                    </a>
                  ))}
                </div>
              </section>
            )}
          </aside>
        )}
      </div>
    </>
  );
}
