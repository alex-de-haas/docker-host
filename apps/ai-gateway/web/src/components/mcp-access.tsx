"use client";

import { useState } from "react";
import { Box, Search, Server } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { ProviderRow } from "@/components/provider-row";
import { CORE_PROVIDER_ID, type Settings, type SettingsResponse } from "@/lib/api";
import { cn } from "@/lib/utils";

export function McpAccess({ data, busy, error, status, feedbackAppId, onSave, onApprove }: {
  data: SettingsResponse;
  busy: boolean;
  error: string | null;
  status: string | null;
  feedbackAppId: string | null;
  onSave: (patch: Partial<Settings>, appId: string) => Promise<void>;
  onApprove: (appId: string, markdown: string) => Promise<void>;
}) {
  const [selectedId, setSelectedId] = useState(CORE_PROVIDER_ID);
  const [search, setSearch] = useState("");
  const { settings, providers, discovery, pendingSkills = [] } = data;
  // Discovery failure must not hide instruction updates that were already available for review.
  const entries = [
    ...providers,
    ...pendingSkills.filter(skill => !providers.some(provider => provider.appId === skill.appId)),
  ].sort((a, b) => a.appId === CORE_PROVIDER_ID ? -1 : b.appId === CORE_PROVIDER_ID ? 1 : 0);
  const query = search.trim().toLocaleLowerCase();
  const visibleEntries = entries.filter(entry =>
    `${entry.displayName} ${entry.appId}`.toLocaleLowerCase().includes(query),
  );
  const selected = visibleEntries.find(entry => entry.appId === selectedId) ?? visibleEntries[0];
  const provider = providers.find(entry => entry.appId === selected?.appId);
  const pendingSkill = pendingSkills.find(skill => skill.appId === selected?.appId);
  const autoAllowSupported = data.harness?.capabilities?.autoAllow !== false;
  const harnessName = data.harness?.name ?? "harness";
  const SelectedIcon = selected?.appId === CORE_PROVIDER_ID ? Server : Box;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      {discovery !== "ok" && (
        <Alert><AlertDescription>
          Could not reach Core, so the app list could not be loaded. Existing access settings are unchanged.
        </AlertDescription></Alert>
      )}
      <div className="grid min-w-0 gap-6 md:grid-cols-[15rem_minmax(0,1fr)] lg:grid-cols-[19rem_minmax(0,1fr)] lg:gap-8">
        <aside aria-label="MCP applications" className="flex min-w-0 flex-col gap-4 md:border-r md:pr-6">
          <div className="flex flex-col gap-1">
            <h2 className="text-base font-semibold">Applications</h2>
            <p className="text-sm text-muted-foreground">Manage assistant access.</p>
          </div>
          <InputGroup>
            <InputGroupInput
              aria-label="Search applications"
              placeholder="Search applications…"
              value={search}
              onChange={event => setSearch(event.target.value)}
            />
            <InputGroupAddon><Search aria-hidden="true" /></InputGroupAddon>
          </InputGroup>
          <nav aria-label="Select an MCP application" className="flex max-h-64 flex-col gap-1 overflow-y-auto p-1 md:max-h-[65vh]">
            {visibleEntries.map(entry => {
              const Icon = entry.appId === CORE_PROVIDER_ID ? Server : Box;
              const enabled = settings.mcpProviders[entry.appId] === true;
              const pending = pendingSkills.some(skill => skill.appId === entry.appId);
              return (
                <Button
                  key={entry.appId}
                  variant={selected?.appId === entry.appId ? "secondary" : "ghost"}
                  className="h-auto w-full justify-start gap-3 px-3 py-3"
                  aria-current={selected?.appId === entry.appId ? "true" : undefined}
                  aria-controls="mcp-application-details"
                  onClick={() => setSelectedId(entry.appId)}
                >
                  <Icon data-icon="inline-start" aria-hidden="true" />
                  <span className="flex min-w-0 flex-1 flex-col items-start gap-1 text-left">
                    <span className="w-full truncate" title={entry.displayName || entry.appId}>{entry.displayName || entry.appId}</span>
                    <span className="flex flex-wrap items-center gap-1.5 text-xs font-normal text-muted-foreground">
                      <span className={cn("size-1.5 shrink-0 rounded-full", enabled ? "bg-success" : "bg-muted-foreground")} aria-hidden="true" />
                      {enabled ? "Enabled" : "Disabled"}
                      {pending && <span>· Review instructions</span>}
                    </span>
                  </span>
                </Button>
              );
            })}
          </nav>
          {discovery === "ok" && !providers.some(entry => entry.appId !== CORE_PROVIDER_ID) && (
            <p className="text-sm text-muted-foreground">No app tools yet. Apps appear here when they expose MCP tools, switched off.</p>
          )}
        </aside>

        <section id="mcp-application-details" aria-label="Application settings" className="flex min-w-0 flex-col gap-6">
          {selected ? (
            <>
              <header className="flex min-w-0 items-center gap-4">
                <div className="flex size-12 shrink-0 items-center justify-center rounded-xl border bg-muted/40">
                  <SelectedIcon className="size-6" aria-hidden="true" />
                </div>
                <div className="flex min-w-0 flex-col gap-1">
                  <h2 className="break-words text-xl font-semibold tracking-tight">{selected.displayName || selected.appId}</h2>
                  <p className="text-sm text-muted-foreground">Assistant access to this application.</p>
                  <p className="break-all text-xs text-muted-foreground">{selected.appId}</p>
                </div>
              </header>
              {provider ? (
                <ProviderRow
                  key={provider.appId}
                  provider={provider}
                  enabled={settings.mcpProviders[provider.appId] === true}
                  autoAllow={settings.mcpAutoAllow[provider.appId] === true}
                  autoAllowSupported={autoAllowSupported}
                  harnessName={harnessName}
                  busy={busy}
                  multipleConnections={data.agentConnections === true}
                  onToggle={next => void onSave({ mcpProviders: { ...settings.mcpProviders, [provider.appId]: next } }, provider.appId)}
                  onApprovalChange={next => void onSave({ mcpAutoAllow: { ...settings.mcpAutoAllow, [provider.appId]: next } }, provider.appId)}
                />
              ) : (
                <Alert><AlertDescription>Access controls are unavailable until this application is discovered again.</AlertDescription></Alert>
              )}

              <Card className="gap-0 overflow-hidden py-0 shadow-none">
                <CardHeader className="bg-muted/40 px-5 py-4">
                  <CardTitle>Application instructions</CardTitle>
                  <CardDescription>{pendingSkill ? "Review the updated instructions before approving them for the assistant." : "Updates supplied by this application appear here for review."}</CardDescription>
                </CardHeader>
                <CardContent className="min-w-0 border-t p-5">
                  {pendingSkill ? (
                    <div className="flex min-w-0 flex-col gap-4">
                      <Badge variant="outline">Review required</Badge>
                      <p className="text-sm text-muted-foreground">These instructions changed since approval. The new text is withheld until you approve it.</p>
                      {/* Show the complete text the approval digest names, never a summary. */}
                      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-4 text-xs leading-relaxed">{pendingSkill.markdown}</pre>
                    </div>
                  ) : <p className="text-sm text-muted-foreground">No instruction updates awaiting approval.</p>}
                </CardContent>
                {pendingSkill && (
                  <CardFooter className="justify-end px-5 pb-5">
                    <Button size="sm" disabled={busy} onClick={() => void onApprove(pendingSkill.appId, pendingSkill.markdown)}>Approve instructions</Button>
                  </CardFooter>
                )}
              </Card>
              <p role="status" className="text-sm text-muted-foreground">{feedbackAppId === selected.appId && busy ? "Saving…" : (feedbackAppId === selected.appId ? status : null) ?? "Access changes save automatically."}</p>
            </>
          ) : (
            <Empty><EmptyHeader>
              <EmptyTitle>{query ? "No matching applications" : "No applications available"}</EmptyTitle>
              <EmptyDescription>{query ? "Try another name or application ID." : "Applications appear here when Core discovers their MCP interface."}</EmptyDescription>
            </EmptyHeader></Empty>
          )}
        </section>
      </div>
    </div>
  );
}
