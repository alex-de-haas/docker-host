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
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Button } from "@/components/ui/button";
import { AgentProviders } from "@/components/agent-providers";
import { ProviderRow } from "@/components/provider-row";
import {
  approveSkill,
  CORE_PROVIDER_ID,
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

  const { settings, providers, discovery } = data;
  // Absent on an older gateway means "assume it works": the flag exists to say when it does not.
  const autoAllowSupported = data.harness?.capabilities?.autoAllow !== false;
  const harnessName = data.harness?.name ?? "harness";
  const apps = providers.filter(
    (provider) => provider.appId !== CORE_PROVIDER_ID,
  );

  return (
    <main className="mx-auto w-full max-w-7xl p-4 sm:p-6">
      <Tabs defaultValue={section} className="gap-6">
        <div className="-m-1 overflow-x-auto overflow-y-hidden p-1">
          <TabsList aria-label="Gateway settings">
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
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {status && (
            <p role="status" className="text-sm text-muted-foreground">
              {status}
            </p>
          )}
          {(data.pendingSkills ?? []).length > 0 && (
            <section>
              <h2 className="text-base font-semibold">
                Changed app instructions
              </h2>
              <p className="mb-3 text-sm text-muted-foreground">
                These apps rewrote the documentation they give the assistant.
                Enabling an app accepted the text it had then, so the new text
                is being withheld until you have read it — an update cannot put
                fresh instructions in front of the model on the strength of an
                older decision.
              </p>
              <div className="grid gap-3">
                {(data.pendingSkills ?? []).map((skill) => (
                  <Card key={skill.appId}>
                    <CardHeader>
                      <CardTitle className="min-w-0 truncate">
                        {skill.displayName}
                      </CardTitle>
                      <CardDescription className="min-w-0 truncate">
                        {skill.appId}
                      </CardDescription>
                      <CardAction>
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            void approve(skill.appId, skill.markdown)
                          }
                        >
                          Approve
                        </Button>
                      </CardAction>
                    </CardHeader>
                    <CardContent>
                      {/* The text itself, not a summary of it: approving prose you cannot read is not
                    approval, and a diff would still hide what the whole now says. */}
                      <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-background p-3 text-xs">
                        {skill.markdown}
                      </pre>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </section>
          )}

          <section>
            <h2 className="text-base font-semibold">MCP access</h2>
            <p className="mb-3 text-sm text-muted-foreground">
              Hosty Core and the installed apps that expose an MCP interface.
              Core starts on, with its read-only tools running unprompted,
              because its tools and their annotations are the platform&apos;s
              own. New apps arrive switched off on purpose: tool names and
              descriptions are text written by the app and land in the context
              of a model that has shell access on this host, so reaching one is
              a decision rather than a side effect of installing it.
            </p>
            {data.agentConnections && (
              <Alert role="note" className="mb-3">
                <AlertDescription>
                  Approval behavior depends on the provider selected for each
                  chat. Claude supports the read-only mode below; Codex uses its
                  own approval rules. Live tool changes apply where the selected
                  provider supports them.
                </AlertDescription>
              </Alert>
            )}
            {!autoAllowSupported && (
              <Alert role="note" className="mb-3">
                <AlertDescription>
                  The {harnessName} harness decides on its own which calls
                  pause, so the approval mode below has no effect on it — every
                  provider asks by that harness&apos;s rules.
                </AlertDescription>
              </Alert>
            )}

            {discovery !== "ok" && (
              <Alert className="mb-2">
                <AlertDescription>
                  Could not reach Core, so the app list could not be loaded.
                  Providers you have already enabled are unchanged and still in
                  effect.
                </AlertDescription>
              </Alert>
            )}
            {providers.length > 0 && (
              <div className="grid gap-2">
                {providers.map((provider) => (
                  <ProviderRow
                    key={provider.appId}
                    provider={provider}
                    enabled={settings.mcpProviders[provider.appId] === true}
                    autoAllow={settings.mcpAutoAllow[provider.appId] === true}
                    autoAllowSupported={autoAllowSupported}
                    harnessName={harnessName}
                    busy={busy}
                    onToggle={(next) =>
                      void save({
                        mcpProviders: {
                          ...settings.mcpProviders,
                          [provider.appId]: next,
                        },
                      })
                    }
                    onApprovalChange={(autoAllow) =>
                      void save({
                        mcpAutoAllow: {
                          ...settings.mcpAutoAllow,
                          [provider.appId]: autoAllow,
                        },
                      })
                    }
                  />
                ))}
              </div>
            )}
            {discovery === "ok" && apps.length === 0 && (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No app tools yet</EmptyTitle>
                  <EmptyDescription>
                    No installed app declares an MCP interface yet. Apps appear
                    here once they do, switched off.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </section>
        </TabsContent>
      </Tabs>
    </main>
  );
}
