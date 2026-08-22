"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ProviderRow } from "@/components/provider-row";
import { approveSkill, establishSession, loadSettings, saveSettings, type Settings, type SettingsResponse } from "@/lib/api";
import { startThemeSync } from "@/lib/shell-theme";

export default function SettingsPage() {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState("");

  useEffect(() => startThemeSync(), []);

  useEffect(() => {
    // The session first, then the data: a launch code that has not been spent yet means every
    // request below would be answered 401 by an app that is working correctly.
    void establishSession()
      .then(loadSettings)
      .then((loaded) => {
        setData(loaded);
        setPrompt(loaded.settings.systemPrompt);
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Could not load settings."));
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

  const save = useCallback(
    async (patch: Partial<Settings>) => {
      setBusy(true);
      setError(null);
      try {
        const saved = await saveSettings(patch);
        setData(saved);
        const live = saved.harness?.capabilities?.liveReconfigure;
        const immediate = patch.mcpProviders || patch.mcpAutoAllow;
        setStatus(immediate && live ? "Applied to running sessions." : "Saved — applies to the next session.");
      } catch (reason: unknown) {
        setError(reason instanceof Error ? reason.message : "Could not save.");
      } finally {
        // Re-rendered from confirmed state whatever happened: the browser mutates a control the
        // moment it is used, so a failed save would otherwise leave a value on screen that the
        // persisted policy does not hold.
        setBusy(false);
      }
    },
    [],
  );

  if (error && !data) {
    return (
      <main className="hosty-page-padding">
        <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">{error}</p>
      </main>
    );
  }

  if (!data) {
    return <main className="hosty-page-padding text-sm text-muted-foreground">Loading…</main>;
  }

  const { settings, providers, discovery } = data;

  return (
    <main className="hosty-page-padding grid gap-7">
      <section>
        <h2 className="text-[15px] font-semibold">System prompt</h2>
        <p className="mb-3 text-[13px] text-muted-foreground">
          Appended to the harness&apos;s own instruction sources, never replacing them.
        </p>
        <textarea
          className="min-h-40 w-full resize-y rounded-lg border bg-transparent p-2.5 text-sm"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
        />
        <div className="mt-2 flex items-center gap-3">
          <Button size="sm" disabled={busy} onClick={() => void save({ systemPrompt: prompt })}>
            Save prompt
          </Button>
          {status && <span className="text-xs text-muted-foreground">{status}</span>}
          {error && <span className="text-xs text-destructive">{error}</span>}
        </div>
      </section>

      {(data.pendingSkills ?? []).length > 0 && (
        <section>
          <h2 className="text-[15px] font-semibold">Changed app instructions</h2>
          <p className="mb-3 text-[13px] text-muted-foreground">
            These apps rewrote the documentation they give the assistant. Enabling an app accepted the
            text it had then, so the new text is being withheld until you have read it — an update
            cannot put fresh instructions in front of the model on the strength of an older decision.
          </p>
          <div className="grid gap-3">
            {(data.pendingSkills ?? []).map((skill) => (
              <div key={skill.appId} className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{skill.displayName}</div>
                    <div className="truncate font-mono text-xs text-muted-foreground">{skill.appId}</div>
                  </div>
                  <Button size="sm" disabled={busy} onClick={() => void approve(skill.appId, skill.markdown)}>
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
        <h2 className="text-[15px] font-semibold">MCP providers</h2>
        <p className="mb-3 text-[13px] text-muted-foreground">
          Installed apps that expose an MCP interface. New apps arrive switched off on purpose: tool
          names and descriptions are text written by the app and land in the context of a model that
          has shell access on this host, so reaching one is a decision rather than a side effect of
          installing it.
        </p>

        {discovery !== "ok" ? (
          <p className="rounded-md border p-3 text-[13px] text-muted-foreground">
            Could not reach Core, so the app list could not be loaded. Providers you have already
            enabled are unchanged and still in effect.
          </p>
        ) : providers.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            No installed app declares an MCP interface yet. Apps appear here once they do, switched off.
          </p>
        ) : (
          <div className="grid gap-2">
            {providers.map((provider) => (
              <ProviderRow
                key={provider.appId}
                provider={provider}
                enabled={settings.mcpProviders[provider.appId] === true}
                autoAllow={settings.mcpAutoAllow[provider.appId] === true}
                busy={busy}
                onToggle={(next) =>
                  void save({ mcpProviders: { ...settings.mcpProviders, [provider.appId]: next } })
                }
                onApprovalChange={(autoAllow) =>
                  void save({ mcpAutoAllow: { ...settings.mcpAutoAllow, [provider.appId]: autoAllow } })
                }
              />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
