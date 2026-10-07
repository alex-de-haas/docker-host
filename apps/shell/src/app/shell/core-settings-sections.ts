import { INGRESS_SETTINGS_GROUP } from "./ingress";
import type { CoreSettingItem } from "./types";

export type CoreSettingsSection = "general" | "policies" | "users" | "ingress";

// Navigation ownership only; Core still owns each setting's value, validation and permissions.
export function coreSettingsSection(item: CoreSettingItem): CoreSettingsSection {
  if (item.group === INGRESS_SETTINGS_GROUP || item.key === "HOSTY_CORE_PORT" || item.key === "HOSTY_CORE_PUBLIC_ORIGIN") return "ingress";
  if (item.key === "HOSTY_USERS_DISABLED_RETENTION_DAYS") return "users";
  if (item.key.startsWith("HOSTY_AUTH_") || item.key.startsWith("HOSTY_OAUTH_")) return "policies";
  return "general";
}
