"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { fetchCore } from "../core-transport.js";
import { isAuthRequiredRedirectError, readCoreError, redirectToCoreLoginIfAuthRequired } from "../core-api";
import type { CoreApp, LogsResponse, LogsServiceSegment } from "../types";
import { InlineError } from "../ui";

type ConsoleLogsState = { loading: boolean; error: string | null; text: string; services: LogsServiceSegment[] };

async function fetchConsoleLogs(coreOrigin: string, appId: string, signal: AbortSignal): Promise<LogsResponse> {
  const response = await fetchCore(`${coreOrigin}/api/apps/${encodeURIComponent(appId)}/logs?tail=200`, {
    credentials: "include", signal,
  });
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  redirectToCoreLoginIfAuthRequired(response, coreOrigin);
  if (!response.ok) throw new Error(await readCoreError(response));
  return await response.json() as LogsResponse;
}

// Core's on-demand console tail works independently of the telemetry backend.
// Mount only while Logs is selected; switching tabs/apps cancels every pending read.
export function ConsoleLogsPanel({ app, coreOrigin }: { app: CoreApp; coreOrigin: string }) {
  const [state, setState] = useState<ConsoleLogsState>({ loading: true, error: null, text: "", services: [] });
  const [activeService, setActiveService] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);

  const loadLogs = useCallback((signal: AbortSignal) =>
    fetchConsoleLogs(coreOrigin, app.id, signal).then(payload => {
      if (signal.aborted) return;
      const services = payload.services ?? [];
      setState({ loading: false, error: null, text: payload.text || "", services });
      setActiveService(current => current && services.some(segment => segment.service === current) ? current : services[0]?.service ?? null);
    }, (error: unknown) => {
      if (signal.aborted || isAuthRequiredRedirectError(error)) return;
      setState({ loading: false, error: error instanceof Error ? error.message : "Console logs are unavailable.", text: "", services: [] });
    }), [app.id, coreOrigin]);

  useEffect(() => {
    const controller = new AbortController();
    request.current = controller;
    void loadLogs(controller.signal);
    return () => request.current?.abort();
  }, [loadLogs]);

  const refresh = () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setState(current => ({ ...current, loading: true, error: null }));
    void loadLogs(controller.signal);
  };
  const activeSegment = state.services.find(segment => segment.service === activeService) ?? state.services[0];
  const body = state.loading ? "Loading logs" : state.services.length ? activeSegment?.text || "No logs" : state.text || "No logs";
  const output = <pre tabIndex={0} aria-label="Console output" aria-busy={state.loading}
    className="max-h-[min(60dvh,48rem)] min-h-80 min-w-0 max-w-full overflow-auto rounded-lg border bg-muted/30 p-4 font-mono text-xs leading-relaxed text-foreground">{body}</pre>;

  return <section aria-label="Console logs" className="flex min-w-0 flex-col gap-4 rounded-xl border bg-card p-4 sm:p-5">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="text-sm font-medium">Console logs</h2><p className="mt-1 text-xs text-muted-foreground">Last 200 lines of runtime output. Refresh to load recent entries.</p></div>
      <Button type="button" variant="outline" size="sm" onClick={refresh} disabled={state.loading}>
        <RefreshCw data-icon="inline-start" className={cn(state.loading && "animate-spin motion-reduce:animate-none")} />Refresh
      </Button>
    </header>
    {state.error && <div role="alert"><InlineError message={state.error} /></div>}
    {state.services.length > 1 ? <Tabs value={activeService ?? state.services[0].service} onValueChange={setActiveService} className="min-w-0 gap-3">
      <div className="max-w-full overflow-x-auto overflow-y-hidden pb-1"><TabsList aria-label="Log service">
        {state.services.map(segment => <TabsTrigger key={segment.service} value={segment.service}>{segment.service}</TabsTrigger>)}
      </TabsList></div>
      <TabsContent value={activeService ?? state.services[0].service} className="min-w-0">{output}</TabsContent>
    </Tabs> : output}
  </section>;
}
