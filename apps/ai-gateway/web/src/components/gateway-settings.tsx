"use client";

import { useCallback, useEffect, useState } from "react";
import { Tabs } from "radix-ui";
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
      <main className="hosty-page-padding">
        <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
          {error}
        </p>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="hosty-page-padding text-sm text-muted-foreground">
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
    <main className="hosty-page-padding">
      <Tabs.Root defaultValue={section}>
        <Tabs.List aria-label="Gateway settings" className="mb-6 flex gap-1 overflow-x-auto border-b">
          {([
            ["providers", "Providers"],
            ["prompt", "System prompt"],
            ["access", "MCP access"],
          ] as const).map(([value, label]) => (
            <Tabs.Trigger
              key={value}
              value={value}
              className="shrink-0 border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=active]:border-foreground data-[state=active]:text-foreground"
            >
              {label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        <Tabs.Content value="providers" forceMount className="data-[state=inactive]:hidden">
          {data.agentConnections && <AgentProviders />}
        </Tabs.Content>
        <Tabs.Content value="prompt" forceMount className="data-[state=inactive]:hidden">
          <section>
            <h2 className="text-[15px] font-semibold">System prompt</h2>
            <p className="mb-3 text-[13px] text-muted-foreground">
              Appended to the harness&apos;s own instruction sources, never
              replacing them.
            </p>
            <textarea
              className="min-h-40 w-full resize-y rounded-lg border bg-transparent p-2.5 text-sm"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
            <div className="mt-2 flex items-center gap-3">
              <Button
                size="sm"
                disabled={busy}
                onClick={() => void save({ systemPrompt: prompt })}
              >
                Save prompt
              </Button>
              {status && (
                <span className="text-xs text-muted-foreground">{status}</span>
              )}
              {error && (
                <span className="text-xs text-destructive">{error}</span>
              )}
            </div>
          </section>
        </Tabs.Content>
        <Tabs.Content value="access" forceMount className="grid gap-7 data-[state=inactive]:hidden">
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {status && (
            <p role="status" className="text-sm text-muted-foreground">
              {status}
            </p>
          )}
          {(data.pendingSkills ?? []).length > 0 && (
            <section>
              <h2 className="text-[15px] font-semibold">
                Changed app instructions
              </h2>
              <p className="mb-3 text-[13px] text-muted-foreground">
                These apps rewrote the documentation they give the assistant.
                Enabling an app accepted the text it had then, so the new text
                is being withheld until you have read it — an update cannot put
                fresh instructions in front of the model on the strength of an
                older decision.
              </p>
              <div className="grid gap-3">
                {(data.pendingSkills ?? []).map((skill) => (
                  <div
                    key={skill.appId}
                    className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3"
                  >
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">
                          {skill.displayName}
                        </div>
                        <div className="truncate font-mono text-xs text-muted-foreground">
                          {skill.appId}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          void approve(skill.appId, skill.markdown)
                        }
                      >
                        Approve
                      </Button>
                    </div>
                    {/* The text itself, not a summary of it: approving prose you cannot read is not
                    approval, and a diff would still hide what the whole now says. */}
                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-background p-3 text-xs">
                      {skill.markdown}
                    </pre>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section>
            <h2 className="text-[15px] font-semibold">MCP access</h2>
            <p className="mb-3 text-[13px] text-muted-foreground">
              Hosty Core and the installed apps that expose an MCP interface.
              Core starts on, with its read-only tools running unprompted,
              because its tools and their annotations are the platform&apos;s
              own. New apps arrive switched off on purpose: tool names and
              descriptions are text written by the app and land in the context
              of a model that has shell access on this host, so reaching one is
              a decision rather than a side effect of installing it.
            </p>
            {data.agentConnections && (
              <p className="mb-3 rounded-md border p-3 text-[13px] text-muted-foreground">
                Approval behavior depends on the provider selected for each
                chat. Claude supports the read-only mode below; Codex uses its
                own approval rules. Live tool changes apply where the selected
                provider supports them.
              </p>
            )}
            {!autoAllowSupported && (
              <p className="mb-3 rounded-md border p-3 text-[13px] text-muted-foreground">
                The {harnessName} harness decides on its own which calls pause,
                so the approval mode below has no effect on it — every provider
                asks by that harness&apos;s rules.
              </p>
            )}

            {discovery !== "ok" && (
              <p className="mb-2 rounded-md border p-3 text-[13px] text-muted-foreground">
                Could not reach Core, so the app list could not be loaded.
                Providers you have already enabled are unchanged and still in
                effect.
              </p>
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
              <p className="mt-2 text-[13px] text-muted-foreground">
                No installed app declares an MCP interface yet. Apps appear here
                once they do, switched off.
              </p>
            )}
          </section>
        </Tabs.Content>
      </Tabs.Root>
    </main>
  );
}
