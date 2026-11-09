"use client";

import { LOCAL_BPE_ESTIMATOR, type LocalContextSources } from "../../../src/harness/context-sources";
import type { ReactNode } from "react";
import type { McpContextDetail } from "../../../src/harness/context-mcp";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import type { McpActivity } from "@/lib/mcp-activity";

const tokens = (value: number) => value.toLocaleString("en");
const providerLabels = { loaded: "Loaded", deferred: "Deferred", available: "Available, not sent", unknown: "Unknown inclusion" };

export function ContextMcpDetail({ detail, sources, observedAt, connected, children, mcpActivity, onDetailOpenChange }: {
  detail?: McpContextDetail; sources?: LocalContextSources; observedAt?: string; connected: boolean; children: ReactNode; mcpActivity?: McpActivity;
  onDetailOpenChange?: (open: boolean) => void;
}) {
  const local = detail?.method === "local-estimate";
  const bpe = Boolean(sources || local && detail?.estimator === LOCAL_BPE_ESTIMATOR);
  const labels = bpe ? { ...providerLabels, unknown: "Available catalog · inclusion unknown" } : local ? { ...providerLabels, loaded: "Sent in request" } : providerLabels;
  const groups = new Map<string, McpContextDetail["tools"]>();
  for (const tool of detail?.tools ?? []) {
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
  const recordedGroups = new Map<string, McpActivity["tools"]>();
  for (const tool of mcpActivity?.tools ?? []) {
    const tools = recordedGroups.get(tool.server) ?? [];
    tools.push(tool); recordedGroups.set(tool.server, tools);
  }
  const recordedServers = [...recordedGroups].map(([server, tools]) => ({ server,
    calls: tools.reduce((sum, tool) => sum + tool.calls, 0),
    tools: tools.sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name)),
  })).sort((a, b) => b.calls - a.calls || a.server.localeCompare(b.server));

  return <Dialog onOpenChange={onDetailOpenChange}>
    <DialogTrigger asChild>{children}</DialogTrigger>
    <DialogContent className="sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>{mcpActivity ? "MCP calls and context" : bpe ? "Local context estimates" : "MCP context detail"}</DialogTitle>
        <DialogDescription>{mcpActivity ? "Recorded calls from this transcript, with separate context estimates." : bpe ? "Estimated size of Hosty instructions and available MCP definitions. The overall context counter remains the native Codex observation." : "Estimated size of tool definitions. Tool results, server instructions and billed usage are not included."}</DialogDescription>
      </DialogHeader>
      <DialogBody>
        <section data-slot="mcp-activity" className="space-y-2" aria-label="Recorded MCP calls">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-medium">Recorded MCP calls</h3>
            {mcpActivity && <span className="font-mono text-sm tabular-nums">{tokens(mcpActivity.total)} {mcpActivity.total === 1 ? "call" : "calls"}</span>}
          </div>
          {!connected && <p role="status" className="text-sm text-muted-foreground">Transcript replay is not caught up while connecting, reconnecting or disconnected. Counts may be incomplete.</p>}
          <p className="text-xs text-muted-foreground">Counts cover the loaded transcript. Denied calls, native code/batch calls and subagent activity can be missing. No record does not mean a tool was unused.</p>
          {!mcpActivity ? <p className="text-sm">Call counts are unavailable in this view.</p>
            : recordedServers.length === 0 ? <p className="text-sm">No MCP calls are recorded in the loaded transcript.</p>
              : recordedServers.map(group => <details key={group.server} data-slot="mcp-activity-server" data-server={group.server} className="min-w-0 rounded-md border p-3">
                <summary className="cursor-pointer break-words text-sm font-medium [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-brand">
                  {group.server} <span className="font-normal text-muted-foreground">· {tokens(group.calls)} {group.calls === 1 ? "call" : "calls"}</span>
                </summary>
                <ul className="mt-2 divide-y">
                  {group.tools.map(tool => <li key={tool.name} data-slot="mcp-activity-tool" data-server={group.server} data-tool={tool.name} className="space-y-1 py-2 text-xs">
                    <div className="flex min-w-0 flex-wrap justify-between gap-2">
                      <span className="min-w-0 flex-1 basis-40 break-words font-mono [overflow-wrap:anywhere]">{tool.name}</span>
                      <span className="font-mono tabular-nums">{tokens(tool.calls)} {tool.calls === 1 ? "call" : "calls"}</span>
                    </div>
                    <p className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
                      {([["Completed", tool.completed], ["Failed/refused", tool.failed], ["Cancelled", tool.cancelled], ["Unknown outcome", tool.unknown]] as const)
                        .filter(([, count]) => count > 0).map(([label, count]) => <span key={label}>{label}: {tokens(count)}</span>)}
                    </p>
                  </li>)}
                </ul>
              </details>)}
        </section>
        {bpe ? <>
          <section className="space-y-1">
            <h3 className="text-sm font-medium">Schema loading · unknown for Codex</h3>
            <p className="text-xs text-muted-foreground">Codex does not report which MCP schemas are loaded in the current context. Catalog presence does not establish whether a tool is loaded.</p>
          </section>
          <section className="space-y-1">
            <h3 className="text-sm font-medium">Actual MCP token usage · unavailable for Codex</h3>
            <p className="text-xs text-muted-foreground">The native context total has no per-MCP token attribution. Definition estimates below do not measure tokens consumed by calls.</p>
          </section>
        </> : !detail && <p className="text-sm text-muted-foreground">Context detail is unavailable. Recorded calls do not establish schema loading or token usage.</p>}
        {sources && <section className="space-y-2">
          <h3 className="text-sm font-medium">Hosty instructions · provided by Hosty</h3>
          <p className="text-xs text-muted-foreground">Text supplied at run start; retention after compaction is unknown. Wrapper and separator overhead are excluded.</p>
          {sources.instructions.length === 0 && <p className="text-sm">No instruction estimates are available for this run.</p>}
          <dl className="space-y-1 text-sm">
            {sources.instructions.map(row => <div key={row.source} className="flex flex-wrap justify-between gap-2">
              <dt>{{ platform: "Platform introduction", runtime: "Runtime instructions", operator: "Operator instructions (workflow, settings, profile)" }[row.source]}</dt>
              <dd className="font-mono text-xs">≈ {tokens(row.tokens)} tokens</dd>
            </div>)}
          </dl>
          {sources.omittedInstructions > 0 && <p role="status" className="text-sm">Partial instructions: {sources.omittedInstructions} blocks exceed the estimate limit.</p>}
        </section>}
        {(detail || sources) && <details data-slot="mcp-definitions" className="min-w-0 rounded-md border p-3">
          <summary className="cursor-pointer text-sm font-medium focus-visible:outline-2 focus-visible:outline-brand">{bpe ? "Estimated available MCP definitions" : "Estimated MCP definitions"}</summary>
          <div className="mt-3 space-y-3">
            <p className="text-sm text-muted-foreground">
              {bpe ? "Local estimate · o200k_base BPE in bounded text chunks. This is a proxy, not the selected model’s exact tokenizer or prompt format. These are available definition sizes, not actual MCP token usage. Tool results, server instructions and billed usage are not included."
                : local ? "Local estimate · UTF-8 JSON bytes ÷ 4, rounded up. This rough comparison does not use the model tokenizer or prompt template. Sent definitions were included in the last measured request; available definitions were not sent."
                  : "Provider estimate · Loaded definitions occupy context. Deferred definitions are available on demand. Unknown inclusion means the provider did not report whether a definition was loaded."}
            </p>
            {observedAt && <p className="text-xs text-muted-foreground">
              {connected ? "Last measured" : "Disconnected · last measured"} {new Date(observedAt).toLocaleString()}.
              {" "}Servers and tools are ordered by definition size. These estimates need not sum to the context total.
            </p>}
            {sources && <p className="text-xs text-muted-foreground">{({ pending: "Catalog collection pending", complete: "Catalog observed", partial: "Partial catalog: some servers or tools could not be measured", unavailable: "Catalog unavailable" })[sources.catalog.state]} · {new Date(sources.catalog.observedAt).toLocaleString()}. Available at collection time; inclusion in current context is unknown.</p>}
            {(detail?.omittedTools ?? 0) > 0 && <p role="status" className="text-sm text-muted-foreground">
              Partial detail: {tokens(detail!.omittedTools)} tool entries were omitted because they exceeded the detail limit, were invalid or repeated. Subtotals cover displayed entries only.
            </p>}
            {servers.length === 0 ? <p className="text-sm">{!detail ? "MCP detail is not available." : detail.omittedTools ? "No valid MCP tool detail is available." : "No MCP tool definitions were reported in this observation."}</p> :
              servers.map(group => <details key={group.server} className="min-w-0 rounded-md border p-3">
                <summary className="cursor-pointer break-words text-sm font-medium [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-brand">
                  {group.server} <span className="font-normal text-muted-foreground">· {group.tools.length} {group.tools.length === 1 ? "tool" : "tools"}</span>
                </summary>
                <dl className={`my-3 grid ${local ? "grid-cols-2" : "grid-cols-3"} gap-2 text-xs`}>
                  {!bpe && <div><dt className="text-muted-foreground">{labels.loaded}</dt><dd className="font-mono">≈ {tokens(group.loaded)} tokens</dd></div>}
                  {(!bpe && (!local || group.deferred > 0)) && <div><dt className="text-muted-foreground">Deferred</dt><dd className="font-mono">≈ {tokens(group.deferred)} tokens</dd></div>}
                  {(!bpe && (local || group.available > 0)) && <div><dt className="text-muted-foreground">Available, not sent</dt><dd className="font-mono">≈ {tokens(group.available)} tokens</dd></div>}
                  {(bpe || !local || group.unknown > 0) && <div><dt className="text-muted-foreground">{labels.unknown}</dt><dd className="font-mono">≈ {tokens(group.unknown)} tokens</dd></div>}
                </dl>
                <ul className="divide-y">
                  {group.tools.map(tool => <li key={tool.name} className="flex min-w-0 flex-wrap items-start justify-between gap-2 py-2 text-sm">
                    <div className="min-w-0 flex-1 basis-40"><p className="break-words font-mono text-xs [overflow-wrap:anywhere]">{tool.name}</p>
                      <p className="text-xs text-muted-foreground">{labels[tool.inclusion]}</p></div>
                    <span className="shrink-0 font-mono text-xs tabular-nums">≈ {tokens(tool.tokens)} tokens</span>
                  </li>)}
                </ul>
              </details>)}
          </div>
        </details>}
      </DialogBody>
    </DialogContent>
  </Dialog>;
}
