"use client";

import { INGRESS_SETTINGS_GROUP } from "../ingress";
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
  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-medium">Core settings</h3>
        <p className="text-xs text-muted-foreground">
          Core&apos;s own behavior settings — auth session lifetimes (in hours), app update checks, and user
          retention — edited here rather than through environment variables. Changes save and apply live.
        </p>
      </div>

      <CoreSettingsForm
        settings={settings}
        error={settingsError}
        onSave={onSaveSettings}
        visible={(item) => item.group !== INGRESS_SETTINGS_GROUP}
      />
    </div>
  );
}
