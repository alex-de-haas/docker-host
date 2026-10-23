"use client";

import { useCallback, useEffect, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { AgentRuntime } from "@/components/agent-runtime";
import { AgentProviders } from "@/components/agent-providers";
import { TranslationProviders } from "@/components/translation-providers";
import { McpAccess } from "@/components/mcp-access";
import {
  loadSettings,
  saveSettings,
  type Settings,
  type SettingsResponse,
} from "@/lib/api";

export function GatewaySettings({
  section = "providers",
}: {
  section?: "providers" | "translation" | "sources" | "prompt" | "access";
}) {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [feedbackAppId, setFeedbackAppId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [workflow, setWorkflow] = useState("");
  const [ordinaryDays, setOrdinaryDays] = useState("");
  const [completedDays, setCompletedDays] = useState("");

  useEffect(() => {
    // The session first, then the data: a launch code that has not been spent yet means every
    // request below would be answered 401 by an app that is working correctly.
    void loadSettings()
      .then((loaded) => {
        setData(loaded);
        setPrompt(loaded.settings.systemPrompt);
        setWorkflow(loaded.settings.workflowPrompt ?? "");
        setOrdinaryDays(loaded.settings.retention?.ordinaryDays?.toString() ?? "");
        setCompletedDays(loaded.settings.retention?.completedWorkspaceDays?.toString() ?? "");
      })
      .catch((reason: unknown) =>
        setError(
          reason instanceof Error ? reason.message : "Could not load settings.",
        ),
      );
  }, []);

  const refresh = useCallback(async () => {
    try { setData(await loadSettings()); setError(null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not refresh MCP access."); }
  }, []);

  const save = useCallback(async (patch: Partial<Settings>, appId: string | null = null) => {
    setFeedbackAppId(appId);
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const saved = await saveSettings(patch);
      setData(saved);
      const live = saved.harness?.capabilities?.liveReconfigure;
      const immediate = patch.mcpAutoAllow;
      setStatus(
        patch.retention ? "Saved — used by the next daily cleanup sweep." : patch.mcpToolRules
          ? "Applied to subsequent tool calls. Already running calls continue."
          : immediate && live
          ? "Applied to running sessions."
          : "Saved — applies to the next session.",
      );
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Could not save.");
    } finally {
      // Re-rendered from confirmed state whatever happened: the browser mutates a control the
      // moment it is used, so a failed save would otherwise leave a value on screen that the
      // persisted policy does not hold.
      setBusy(false);
    }
  }, []);

  if (error && !data) {
    return (
      <main className="mx-auto w-full max-w-7xl p-4 sm:p-6">
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="mx-auto w-full max-w-7xl p-4 sm:p-6 text-sm text-muted-foreground">
        Loading…
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-4 sm:p-6 lg:p-8">
      <h1 className="text-2xl font-semibold tracking-[-0.02em]">Hosty Harness</h1>
      <Tabs defaultValue={section} className="gap-6">
        <div className="-m-1 overflow-x-auto overflow-y-hidden p-1">
          <TabsList variant="line" aria-label="Hosty Harness settings">
            {(
              [
                ["providers", "Agent providers"],
                ["translation", "Translation providers"],
                ["prompt", "Instructions and retention"],
                ["access", "MCP access"],
              ] as const
            ).map(([value, label]) => (
              <TabsTrigger key={value} value={value}>
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent
          value="providers"
          forceMount
          className="data-[state=inactive]:hidden"
        >
          <AgentRuntime />
          {data.agentConnections && <AgentProviders />}
        </TabsContent>
        <TabsContent value="translation">
          {data.agentConnections && <TranslationProviders />}
        </TabsContent>
        <TabsContent value="sources"><p>Manage your GitHub connections and Git identity in Hosty Shell → Settings → Source connections.</p></TabsContent>
        <TabsContent
          value="prompt"
          forceMount
          className="data-[state=inactive]:hidden"
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="workflow-prompt">Development workflow</FieldLabel>
              <FieldDescription>Edit or clear the default process. Plans and specification-driven development are optional. Changes apply when the next agent session starts; permissions and Core completion checks remain enforced.</FieldDescription>
              <Textarea id="workflow-prompt" className="min-h-64 resize-y" value={workflow} maxLength={8000} onChange={event => setWorkflow(event.target.value)} />
              <div className="flex gap-2">
                <Button size="sm" disabled={busy} onClick={() => void save({ workflowPrompt: workflow })}>Save workflow</Button>
                <Button size="sm" variant="outline" disabled={busy || !data.defaults} onClick={() => setWorkflow(data.defaults!.workflowPrompt)}>Restore default draft</Button>
              </div>
            </Field>
            <Field>
              <FieldLabel htmlFor="ordinary-retention">Ordinary chat retention (days)</FieldLabel>
              <FieldDescription>After the last conversation activity. Leave empty for Off. Live sandbox-only sessions remain protected until Finish.</FieldDescription>
              <input id="ordinary-retention" type="number" min={1} max={3650} step={1} placeholder="Off" className="rounded-md border bg-background px-3 py-2 outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-brand focus-visible:ring-0 focus-visible:border-brand" value={ordinaryDays} onChange={event => setOrdinaryDays(event.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="workspace-retention">Completed workspace retention (days)</FieldLabel>
              <FieldDescription>After explicit Core-verified completion or later conversation activity. Leave empty for Off. Unfinished and deferred workspaces never expire. Core rechecks all repositories before deleting worktrees, owned previews and the conversation. Background source cleanup requires the reviewed apps.workspaces.cleanup permission.</FieldDescription>
              <input id="workspace-retention" type="number" min={1} max={3650} step={1} placeholder="Off" className="rounded-md border bg-background px-3 py-2 outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-brand focus-visible:ring-0 focus-visible:border-brand" value={completedDays} onChange={event => setCompletedDays(event.target.value)} />
            </Field>
            <div><Button size="sm" disabled={busy || [ordinaryDays, completedDays].some(value => value !== "" && (!Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > 3650))}
              onClick={() => void save({ retention: { ordinaryDays: ordinaryDays === "" ? null : Number(ordinaryDays), completedWorkspaceDays: completedDays === "" ? null : Number(completedDays) } })}>Save retention</Button></div>
            <Field>
              <label className="flex items-center gap-2">
                <input type="checkbox" className="outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-brand focus-visible:ring-0" checked={data.settings.immediateHandoffs === true} disabled={busy}
                  onChange={event => void save({ immediateHandoffs: event.target.checked })} />
                Start received prompts immediately
              </label>
              <FieldDescription>Off by default: received prompts wait as drafts. Enabling this also lets authorized apps submit prompts without individual Send confirmation. Tool permissions still apply.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="system-prompt">System prompt</FieldLabel>
              <FieldDescription id="system-prompt-description">
                Appended to the harness&apos;s own instruction sources, never
                replacing them.
              </FieldDescription>
              <Textarea
                id="system-prompt"
                aria-describedby="system-prompt-description"
                className="min-h-40 resize-y"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
              />
            </Field>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                size="sm"
                disabled={busy}
                onClick={() => void save({ systemPrompt: prompt })}
              >
                Save prompt
              </Button>
              {status && (
                <p role="status" className="text-sm text-muted-foreground">
                  {status}
                </p>
              )}
            </div>
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </FieldGroup>
        </TabsContent>
        <TabsContent
          value="access"
          forceMount
          className="grid gap-7 data-[state=inactive]:hidden"
        >
          <McpAccess
            onRefresh={refresh}
            data={data}
            busy={busy}
            error={error}
            status={status}
            feedbackAppId={feedbackAppId}
            onSave={save}
          />
        </TabsContent>
      </Tabs>
    </main>
  );
}
