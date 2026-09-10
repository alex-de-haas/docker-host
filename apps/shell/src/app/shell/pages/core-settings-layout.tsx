import type { ReactNode } from "react";
import type { CoreSettingItem } from "../types";

// Shell owns the layout of known Core settings. Core remains authoritative for values, types,
// descriptions and defaults. Unknown keys stay editable when Core is newer than this Shell.
const sessions = [
  { title: "Admin", keys: ["HOSTY_AUTH_CORE_SESSION_IDLE_HOURS", "HOSTY_AUTH_CORE_SESSION_ABSOLUTE_HOURS"] },
  { title: "Apps", keys: ["HOSTY_AUTH_APP_GRANT_IDLE_HOURS", "HOSTY_AUTH_APP_GRANT_ABSOLUTE_HOURS"] },
  { title: "System apps", keys: ["HOSTY_AUTH_SYSTEM_GRANT_IDLE_HOURS", "HOSTY_AUTH_SYSTEM_GRANT_ABSOLUTE_HOURS"] },
];

const sections = [
  { title: "Access", fields: [
    { key: "HOSTY_AUTH_ACCESS_TOKEN_IDLE_HOURS", label: "Access token idle timeout" },
    { key: "HOSTY_AUTH_CLI_GRANT_HOURS", label: "CLI diagnostic grant lifetime" },
    { key: "HOSTY_OAUTH_DCR_ENABLED" },
  ] },
  { title: "Maintenance", fields: [
    { key: "HOSTY_UPDATE_CHECK_INTERVAL_MINUTES", label: "Check for app updates every" },
    { key: "HOSTY_USERS_DISABLED_RETENTION_DAYS", label: "Delete disabled users after" },
  ] },
  { title: "Connection", fields: [
    { key: "HOSTY_CORE_PORT" },
    { key: "HOSTY_CORE_PUBLIC_ORIGIN" },
  ] },
];

const knownKeys = new Set([
  ...sessions.flatMap((session) => session.keys),
  ...sections.flatMap((section) => section.fields.map((field) => field.key)),
]);

export function CoreSettingsLayout({ items, renderField }: {
  items: CoreSettingItem[];
  renderField: (item: CoreSettingItem, label?: string) => ReactNode;
}) {
  const byKey = new Map(items.map((item) => [item.key, item]));
  const extra = items.filter((item) => !knownKeys.has(item.key));
  return (
    <div className="space-y-4">
      {sessions.some((session) => session.keys.some((key) => byKey.has(key))) && (
        <section className="rounded-lg border p-4" aria-label="Sessions">
          <h4 className="mb-3 text-sm font-medium">Sessions</h4>
          <div className="grid gap-5 lg:grid-cols-3">
            {sessions.map((session) => (
              session.keys.some((key) => byKey.has(key)) && (
                <fieldset key={session.title} className="min-w-0 space-y-3">
                  <legend className="mb-2 text-xs text-muted-foreground">{session.title}</legend>
                  {session.keys.map((key) => {
                    const item = byKey.get(key);
                    return item ? renderField(item) : null;
                  })}
                </fieldset>
              )
            ))}
          </div>
        </section>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        {sections.map((section) => (
          section.fields.some((field) => byKey.has(field.key)) && (
            <section key={section.title} className={`min-w-0 rounded-lg border p-4 ${section.title === "Connection" ? "lg:col-span-2" : ""}`} aria-label={section.title}>
              <h4 className="mb-3 text-sm font-medium">{section.title}</h4>
              <div className={section.title === "Connection" ? "grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]" : "space-y-3"}>
                {section.fields.map((field) => {
                  const item = byKey.get(field.key);
                  return item ? renderField(item, "label" in field ? field.label : undefined) : null;
                })}
              </div>
            </section>
          )
        ))}
      </div>
      {extra.length > 0 && (
        <section className="rounded-lg border p-4" aria-label="Additional settings">
          <h4 className="mb-3 text-sm font-medium">Additional settings</h4>
          <div className="grid gap-4 lg:grid-cols-2">{extra.map((item) => renderField(item))}</div>
        </section>
      )}
    </div>
  );
}
