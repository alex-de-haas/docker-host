"use client";

import { useEffect, useMemo, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CloudflareConnectionCard } from "../dialogs/cloudflare-connection-card";
import { SettingInput } from "../settings";
import type { CoreSettingItem, CoreSettingsState } from "../types";
import { InlineError } from "../ui";

// Core's own configuration, and the only surface that edits it. It used to be a dialog opened from
// the sidebar version block — a place nothing looked like navigation. It used to carry an Extensions
// section toggling which first-party apps Core preinstalls; that concept is gone — first-party apps
// are installed and uninstalled like any other app. See docs/features/removable-system-apps/.
//
// Read-only facts about Core — version, origins, data root, and a waiting update — live on Dashboard
// instead: this page is for what an operator changes, not for what the host reports.
export function SettingsCoreSection({
  settings,
  settingsError,
  onSaveSettings,
}: {
  settings: CoreSettingsState | null;
  settingsError: string | null;
  onSaveSettings: (values: Record<string, string>) => Promise<void>;
}) {
  return (
    <div className="space-y-4">
      <CoreSettingsForm settings={settings} error={settingsError} onSave={onSaveSettings} />

      <div className="border-t" />

      <CloudflareConnectionCard />
    </div>
  );
}

// Core's own behavior settings (auth session lifetimes + cloudflared ingress), rendered with the shared
// per-app settings inputs and grouped by the `group` Core returns. Live-apply: saving PUTs the changed
// keys and Core returns the fresh snapshot (no restart affordance) — an ingress change also re-renders
// the tunnel config server-side. Per-field copy explains what applies immediately.
function CoreSettingsForm({
  settings,
  error,
  onSave,
}: {
  settings: CoreSettingsState | null;
  error: string | null;
  onSave: (values: Record<string, string>) => Promise<void>;
}) {
  const items = useMemo(() => settings?.settings ?? [], [settings]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Reseed the editable draft whenever Core returns a fresh snapshot (initial load and after a save).
  useEffect(() => {
    setDraft(Object.fromEntries(items.map((item) => [item.key, item.value])));
    setSaveError(null);
  }, [items]);

  const groups = useMemo(() => groupCoreSettings(items), [items]);
  const changed = items.filter((item) => (draft[item.key] ?? item.value) !== item.value).map((item) => item.key);

  const save = async () => {
    if (changed.length === 0) {
      return;
    }

    setSaving(true);
    setSaveError(null);
    try {
      await onSave(Object.fromEntries(changed.map((key) => [key, draft[key] ?? ""])));
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "The settings could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  // Clears a persisted override so the key falls back to Core's env/default. A blank value is the
  // "null to clear" contract on the endpoint; Core returns the fresh snapshot, which reseeds the draft.
  const reset = async (key: string) => {
    setSaving(true);
    setSaveError(null);
    try {
      await onSave({ [key]: "" });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "The setting could not be reset.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-medium">Core settings</h3>
        <p className="text-xs text-muted-foreground">
          Core&apos;s own behavior settings — auth session lifetimes (in hours) and public ingress — edited here rather than
          through environment variables. Changes save and apply live; see each setting for what takes effect immediately.
        </p>
      </div>

      {error && <InlineError message={error} />}
      {saveError && <InlineError message={saveError} />}

      {!settings && !error && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" aria-hidden /> Loading Core settings…
        </p>
      )}

      {settings && groups.length > 0 && (
        <div className="space-y-4">
          {groups.map((group) => (
            <div key={group.name} className="space-y-3 rounded-md border p-3">
              <p className="text-xs font-medium text-muted-foreground">{group.name}</p>
              {group.items.map((item) => (
                <div key={item.key} className="space-y-1">
                  <SettingInput
                    setting={{
                      key: item.key,
                      type: item.type,
                      label: item.label,
                      description: item.description,
                      required: false,
                      secret: false,
                      options: item.options,
                    }}
                    value={draft[item.key] ?? item.value}
                    disabled={saving}
                    onChange={(value) => setDraft((current) => ({ ...current, [item.key]: value }))}
                  />
                  {item.overridden && (
                    <div className="flex justify-end">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-xs text-muted-foreground"
                        disabled={saving}
                        onClick={() => reset(item.key)}
                      >
                        {item.default ? `Reset to default (${item.default}${item.unit ?? ""})` : "Reset to default"}
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))}

          <div className="flex items-center gap-3">
            <Button size="sm" disabled={saving || changed.length === 0} onClick={save}>
              {saving && <LoaderCircle className="size-3.5 animate-spin" aria-hidden />}
              Save settings
            </Button>
            {changed.length > 0 && !saving && (
              <span className="text-xs text-muted-foreground">
                {changed.length} unsaved change{changed.length === 1 ? "" : "s"}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function groupCoreSettings(items: CoreSettingItem[]) {
  const groups: Array<{ name: string; items: CoreSettingItem[] }> = [];
  for (const item of items) {
    const existing = groups.find((group) => group.name === item.group);
    if (existing) {
      existing.items.push(item);
    } else {
      groups.push({ name: item.group, items: [item] });
    }
  }

  return groups;
}
