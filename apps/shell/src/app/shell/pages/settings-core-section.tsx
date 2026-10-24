"use client";

import { coreSettingsSection, type CoreSettingsSection } from "../core-settings-sections";
import type { CoreSettingsState, CoreStatus } from "../types";
import { CoreSettingsForm } from "./core-settings-form";
import { CoreHostInformation } from "./core-host-information";

export function SettingsCoreSection({ section, settings, settingsError, coreStatus, onSaveSettings }: {
  section: Exclude<CoreSettingsSection, "ingress">;
  settings: CoreSettingsState | null;
  settingsError: string | null;
  coreStatus?: CoreStatus | null;
  onSaveSettings: (values: Record<string, string>) => Promise<void>;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
    {section === "general" && <CoreHostInformation status={coreStatus} />}
    {section === "policies" && Boolean(settings?.authenticationDiagnostics?.length) && (
      <details className="rounded-md border p-3 text-sm text-muted-foreground">
        <summary className="cursor-pointer font-medium">App session policy migration</summary>
        <ul className="mt-2 space-y-2">
          {settings?.authenticationDiagnostics?.map(message => <li key={message}>{message}</li>)}
        </ul>
      </details>
    )}
    <CoreSettingsForm
      key={section}
      layout="core"
      settings={settings}
      error={settingsError}
      onSave={onSaveSettings}
      visible={item => coreSettingsSection(item) === section}
    />
    </div>
  );
}
