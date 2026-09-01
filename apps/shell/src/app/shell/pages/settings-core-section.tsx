"use client";

import { useState } from "react";
import { CORE_PUBLIC_ORIGIN_SETTING_KEY, INGRESS_SETTINGS_GROUP } from "../ingress";
import type { CoreSettingsState } from "../types";
import { CoreSettingsForm } from "./core-settings-form";

// Core's own configuration, and the only surface that edits it. It used to be a dialog opened from
// the sidebar version block — a place nothing looked like navigation. It used to carry an Extensions
// section toggling which first-party apps Core preinstalls; that concept is gone — first-party apps
// are installed and uninstalled like any other app. See docs/features/removable-system-apps/.
//
// Public ingress used to be one more group here, with the Cloudflare connection card underneath it as a
// separate feature. They were never separate: both drive a Cloudflare tunnel, and they are mutually
// exclusive. They now live together on the Ingress tab, where the provider is one choice.
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
  // Tracks the form's draft so the two-stage warning appears while the operator is typing the new
  // origin, not after they have already saved it and moved on.
  const [draftOrigin, setDraftOrigin] = useState<string | null>(null);
  const savedOrigin = settings?.settings.find((item) => item.key === CORE_PUBLIC_ORIGIN_SETTING_KEY)?.value ?? null;
  const originChanged = draftOrigin !== null && savedOrigin !== null && draftOrigin.trim() !== savedOrigin;

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-medium">Core settings</h3>
        <p className="text-xs text-muted-foreground">
          Core&apos;s own behavior settings — auth session lifetimes (in hours), app update checks, and user
          retention — edited here rather than through environment variables. Changes save and apply live.
        </p>
      </div>

      {/* The public origin is the one setting on this page whose effect arrives in two stages, so it is
          said here, next to the field, at the moment it is being changed. "Changes apply live" above is
          true of everything Core itself does with the value; it is not true of the copy each installed
          app was handed when it started. */}
      {originChanged && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
          <p className="font-medium">Saving the public origin takes effect in two stages</p>
          <p>
            Sign-in and invitation links, and the metadata agent clients read, use the new address as soon as you
            save. Installed apps were handed the old one when they started and keep using it until they restart.
          </p>
        </div>
      )}

      <CoreSettingsForm
        settings={settings}
        error={settingsError}
        onSave={onSaveSettings}
        visible={(item) => item.group !== INGRESS_SETTINGS_GROUP}
        onDraftChange={(draft) => setDraftOrigin(draft[CORE_PUBLIC_ORIGIN_SETTING_KEY] ?? null)}
      />
    </div>
  );
}
