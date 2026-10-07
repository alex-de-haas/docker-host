"use client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { markdownTarget } from "@/lib/markdown";
import { planLink } from "@/lib/model";
import type { ParsedDocument } from "@/lib/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export function SourceDocument({ document, repositoryId, navigate }: { document: ParsedDocument; repositoryId: string; navigate: (url: string) => void }) {
  return <>
    {document.errors.length > 0 && <Alert variant="destructive"><AlertTitle>Document needs attention</AlertTitle><AlertDescription><ul className="list-disc pl-4">{document.errors.map((error, index) => <li key={index}>{error}</li>)}</ul><p>Progress is unknown until these errors are resolved.</p></AlertDescription></Alert>}
    <div className="markdown">
      <ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} urlTransform={value => value} components={{
        a: ({ href = "", children }) => {
          const target = markdownTarget(document.path, href);
          if (target.kind === "external") return <a href={target.value} target="_blank" rel="noopener noreferrer">{children}</a>;
          if (target.kind === "anchor") return <a href={target.value}>{children}</a>;
          if (target.kind === "document") return <a href={planLink(repositoryId, target.path!)} onClick={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey) { event.preventDefault(); navigate(planLink(repositoryId, target.path!)); } }}>{children}</a>;
          return <span>{children} <code className="source-path">({target.value})</code></span>;
        },
        img: ({ src = "", alt = "" }) => {
          const target = markdownTarget(document.path, String(src));
          if (target.kind === "external") return <a href={target.value} target="_blank" rel="noopener noreferrer">{alt || "Image"} ({target.value})</a>;
          return <span className="source-path">{alt || "Image"} ({target.path ?? target.value})</span>;
        },
        table: ({ children }) => <Table>{children}</Table>,
        thead: ({ children }) => <TableHeader>{children}</TableHeader>,
        tbody: ({ children }) => <TableBody>{children}</TableBody>,
        tr: ({ children }) => <TableRow>{children}</TableRow>,
        th: ({ children, style }) => <TableHead style={style}>{children}</TableHead>,
        td: ({ children, style }) => <TableCell style={style}>{children}</TableCell>,
      }}>{document.body}</ReactMarkdown>
    </div>
  </>;
}
