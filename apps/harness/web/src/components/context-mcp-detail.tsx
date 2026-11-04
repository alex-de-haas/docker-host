"use client";

import type { ReactNode } from "react";
import type { McpContextDetail } from "../../../src/harness/context-mcp";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

const tokens = (value: number) => value.toLocaleString("en");
const providerLabels = { loaded: "Loaded", deferred: "Deferred", available: "Available, not sent", unknown: "Unknown inclusion" };

export function ContextMcpDetail({ detail, observedAt, connected, children }: {
  detail: McpContextDetail; observedAt: string; connected: boolean; children: ReactNode;
}) {
  const local = detail.method === "local-estimate";
  const labels = local ? { ...providerLabels, loaded: "Sent in request" } : providerLabels;
  const groups = new Map<string, McpContextDetail["tools"]>();
  for (const tool of detail.tools) {
    const tools = groups.get(tool.server) ?? [];
    tools.push(tool); groups.set(tool.server, tools);
  }
  const servers = [...groups].map(([server, tools]) => ({ server,
    tools: tools.sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name)),
    total: tools.reduce((sum, tool) => sum + tool.tokens, 0),
    loaded: tools.filter(tool => tool.inclusion === "loaded").reduce((sum, tool) => sum + tool.tokens, 0),
    deferred: tools.filter(tool => tool.inclusion === "deferred").reduce((sum, tool) => sum + tool.tokens, 0),
    available: tools.filter(tool => tool.inclusion === "available").reduce((sum, tool) => sum + tool.tokens, 0),
    unknown: tools.filter(tool => tool.inclusion === "unknown").reduce((sum, tool) => sum + tool.tokens, 0),
  })).sort((a, b) => b.total - a.total || a.server.localeCompare(b.server));

  return <Dialog>
    <DialogTrigger asChild>{children}</DialogTrigger>
    <DialogContent className="sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>MCP context detail</DialogTitle>
        <DialogDescription>Estimated size of tool definitions. Tool results, server instructions and billed usage are not included.</DialogDescription>
      </DialogHeader>
      <DialogBody>
        <p className="text-sm text-muted-foreground">
          {local ? "Local estimate · UTF-8 JSON bytes ÷ 4, rounded up. This rough comparison does not use the model tokenizer or prompt template. Sent definitions were included in the last measured request; available definitions were not sent."
            : "Provider estimate · Loaded definitions occupy context. Deferred definitions are available on demand. Unknown inclusion means the provider did not report whether a definition was loaded."}
        </p>
        <p className="text-xs text-muted-foreground">
          {connected ? "Last measured" : "Disconnected · last measured"} {new Date(observedAt).toLocaleString()}.
          {" "}Servers and tools are ordered by definition size. These estimates need not sum to the context total.
        </p>
        {detail.omittedTools > 0 && <p role="status" className="text-sm text-muted-foreground">
          Partial detail: {tokens(detail.omittedTools)} tool entries were omitted because they exceeded the detail limit, were invalid or repeated. Subtotals cover displayed entries only.
        </p>}
        {servers.length === 0 ? <p className="text-sm">{detail.omittedTools ? "No valid MCP tool detail is available." : "No MCP tool definitions were reported in this observation."}</p> :
          servers.map(group => <details key={group.server} className="min-w-0 rounded-md border p-3">
            <summary className="cursor-pointer break-words text-sm font-medium [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-brand">
              {group.server} <span className="font-normal text-muted-foreground">· {group.tools.length} {group.tools.length === 1 ? "tool" : "tools"}</span>
            </summary>
            <dl className={`my-3 grid ${local ? "grid-cols-2" : "grid-cols-3"} gap-2 text-xs`}>
              <div><dt className="text-muted-foreground">{labels.loaded}</dt><dd className="font-mono">≈ {tokens(group.loaded)} tokens</dd></div>
              {(!local || group.deferred > 0) && <div><dt className="text-muted-foreground">Deferred</dt><dd className="font-mono">≈ {tokens(group.deferred)} tokens</dd></div>}
              {(local || group.available > 0) && <div><dt className="text-muted-foreground">Available, not sent</dt><dd className="font-mono">≈ {tokens(group.available)} tokens</dd></div>}
              {(!local || group.unknown > 0) && <div><dt className="text-muted-foreground">Unknown inclusion</dt><dd className="font-mono">≈ {tokens(group.unknown)} tokens</dd></div>}
            </dl>
            <ul className="divide-y">
              {group.tools.map(tool => <li key={tool.name} className="flex min-w-0 flex-wrap items-start justify-between gap-2 py-2 text-sm">
                <div className="min-w-0 flex-1 basis-40"><p className="break-words font-mono text-xs [overflow-wrap:anywhere]">{tool.name}</p>
                  <p className="text-xs text-muted-foreground">{labels[tool.inclusion]}</p></div>
                <span className="shrink-0 font-mono text-xs tabular-nums">≈ {tokens(tool.tokens)} tokens</span>
              </li>)}
            </ul>
          </details>)}
      </DialogBody>
    </DialogContent>
  </Dialog>;
}
