import type { ReactNode } from "react";
import { Frame, FrameHeader, FramePanel } from "@/components/reui/frame";
import { FieldGroup } from "@/components/ui/field";
import type { CoreSettingItem } from "../types";
import { INGRESS_SETTINGS_GROUP } from "../ingress";

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
  ] },
  { title: "User retention", fields: [
    { key: "HOSTY_USERS_DISABLED_RETENTION_DAYS", label: "Delete disabled users after" },
  ] },
  { title: "Privileged activity", fields: [{ key: "HOSTY_AUTH_APP_ACTIVITY_HOURS" }] },
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
  const ingress = items.filter(item => item.group === INGRESS_SETTINGS_GROUP);
  const extra = items.filter((item) => !knownKeys.has(item.key) && item.group !== INGRESS_SETTINGS_GROUP);
  const group = (title: string, fields: ReactNode) => <section key={title} className="min-w-0" aria-label={title}>
    <Frame>
      <FrameHeader><h3 className="text-sm font-medium">{title}</h3></FrameHeader>
      <FramePanel><FieldGroup className="gap-5">{fields}</FieldGroup></FramePanel>
    </Frame>
  </section>;
  return <div className="flex min-w-0 flex-col gap-4">
    {sessions.some(session => session.keys.some(key => byKey.has(key))) && group("Sessions", sessions.map(session => session.keys.some(key => byKey.has(key)) ? <div key={session.title} className="flex flex-col gap-4">
      <h4 className="text-sm font-medium text-muted-foreground">{session.title}</h4>
      <FieldGroup className="gap-4">{session.keys.map(key => { const item = byKey.get(key); return item ? renderField(item) : null; })}</FieldGroup>
    </div> : null))}
    {sections.map(section => section.fields.some(field => byKey.has(field.key)) ? group(section.title, section.fields.map(field => {
      const item = byKey.get(field.key); return item ? renderField(item, "label" in field ? field.label : undefined) : null;
    })) : null)}
    {ingress.length > 0 && group("Public ingress", ingress.map(item => renderField(item)))}
    {extra.length > 0 && group("Additional settings", extra.map(item => renderField(item)))}
  </div>;
}
