"use client";

import { useEffect, useMemo, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SettingInput } from "../settings";
import type { CoreSettingItem, CoreSettingsState } from "../types";
import { InlineError } from "../ui";

// The editable form over Core's own settings, shared by the Core and Ingress tabs. Core returns one flat
// list tagged with a `group`; each tab decides which of those groups it owns, so this component takes a
// filter rather than rendering everything it is given. Live-apply: saving PUTs only the changed keys and
// Core returns the fresh snapshot, which reseeds the draft.
//
// `visible` is evaluated against the *draft*, not the saved snapshot, so a field whose relevance depends
// on another field (the ingress provider) appears the moment the operator changes it rather than after a
// save.
export function CoreSettingsForm({
  settings,
  error,
  onSave,
  visible,
  showGroupHeadings = true,
  onDraftChange,
}: {
  settings: CoreSettingsState | null;
  error: string | null;
  onSave: (values: Record<string, string>) => Promise<void>;
  visible?: (item: CoreSettingItem, draft: Record<string, string>) => boolean;
  showGroupHeadings?: boolean;
  onDraftChange?: (draft: Record<string, string>) => void;
}) {
  const items = useMemo(() => settings?.settings ?? [], [settings]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Reseed the editable draft whenever Core returns a fresh snapshot (initial load and after a save).
  // Seeded from every item, not just the visible ones: a hidden field still has a value, and dropping it
  // here would make the change set look like a clear.
  useEffect(() => {
    const next = Object.fromEntries(items.map((item) => [item.key, item.value]));
    setDraft(next);
    onDraftChange?.(next);
    setSaveError(null);
    // onDraftChange is a notification, not an input: including it would reseed on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  const shown = useMemo(
    () => items.filter((item) => (visible ? visible(item, draft) : true)),
    [items, visible, draft],
  );
  const groups = useMemo(() => groupCoreSettings(shown), [shown]);
  // Only visible fields can be edited, so only they can contribute a change. A field hidden by the
  // current draft (another provider's tunnel id, say) keeps its stored value untouched.
  const changed = shown.filter((item) => (draft[item.key] ?? item.value) !== item.value).map((item) => item.key);

  // The next draft is computed here rather than inside a setDraft updater: React calls an updater during
  // the render phase, so notifying the parent from in there sets state on another component mid-render.
  const update = (key: string, value: string) => {
    const next = { ...draft, [key]: value };
    setDraft(next);
    onDraftChange?.(next);
  };

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
              {showGroupHeadings && <p className="text-xs font-medium text-muted-foreground">{group.name}</p>}
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
                    onChange={(value) => update(item.key, value)}
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
