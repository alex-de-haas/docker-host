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
import { AgentProviders } from "@/components/agent-providers";
import { McpAccess } from "@/components/mcp-access";
import {
  approveSkill,
  establishSession,
  loadSettings,
  saveSettings,
  type Settings,
  type SettingsResponse,
} from "@/lib/api";

export function GatewaySettings({
  section = "providers",
}: {
  section?: "providers" | "prompt" | "access";
}) {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState("");

  useEffect(() => {
    // The session first, then the data: a launch code that has not been spent yet means every
    // request below would be answered 401 by an app that is working correctly.
    void establishSession()
      .then(loadSettings)
      .then((loaded) => {
        setData(loaded);
        setPrompt(loaded.settings.systemPrompt);
      })
      .catch((reason: unknown) =>
        setError(
          reason instanceof Error ? reason.message : "Could not load settings.",
        ),
      );
  }, []);

  const approve = useCallback(async (appId: string, markdown: string) => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await approveSkill(appId, markdown);
      // Re-read rather than dropping the row locally: the server decides what is still pending, and a
      // second change landing between the read and the click must reappear rather than vanish.
      setData(await loadSettings());
      setStatus("Approved — applies to the next session.");
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Could not approve.");
    } finally {
      setBusy(false);
    }
  }, []);

  const save = useCallback(async (patch: Partial<Settings>) => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const saved = await saveSettings(patch);
      setData(saved);
      const live = saved.harness?.capabilities?.liveReconfigure;
      const immediate = patch.mcpProviders || patch.mcpAutoAllow;
      setStatus(
        immediate && live
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
      <h1 className="text-2xl font-semibold tracking-tight">AI Gateway</h1>
      <Tabs defaultValue={section} className="gap-6">
        <div className="-m-1 overflow-x-auto overflow-y-hidden p-1">
          <TabsList variant="line" aria-label="Gateway settings">
            {(
              [
                ["providers", "Providers"],
                ["prompt", "System prompt"],
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
          {data.agentConnections && <AgentProviders />}
        </TabsContent>
        <TabsContent
          value="prompt"
          forceMount
          className="data-[state=inactive]:hidden"
        >
          <FieldGroup>
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
            data={data}
            busy={busy}
            error={error}
            status={status}
            onSave={save}
            onApprove={approve}
          />
        </TabsContent>
      </Tabs>
    </main>
  );
}
