"use client";

import { coreSettingsSection, type CoreSettingsSection } from "../core-settings-sections";
import type { CoreSettingsState } from "../types";
import { CoreSettingsForm } from "./core-settings-form";

export function SettingsCoreSection({ section, settings, settingsError, onSaveSettings }: {
  section: Exclude<CoreSettingsSection, "ingress">;
  settings: CoreSettingsState | null;
  settingsError: string | null;
  onSaveSettings: (values: Record<string, string>) => Promise<void>;
}) {
  return (
    <CoreSettingsForm
      key={section}
      layout="core"
      settings={settings}
      error={settingsError}
      onSave={onSaveSettings}
      visible={item => coreSettingsSection(item) === section}
    />
  );
}
