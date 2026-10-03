import type { AppPermissionState } from "./providers.js";

export type PermissionNoticeState = {
  hostRole: string | null;
  appId: string;
  corePublicOrigin: string | null;
  permissions: AppPermissionState | null;
};
