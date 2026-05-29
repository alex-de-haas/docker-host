import type { InstalledModuleRecord, ModuleOperationStatus, ModuleRuntimeState } from './modules';

export type HostAppAccessMode = 'allAuthenticated' | 'assignedUsersOnly';

export type HostAppStatus = 'available' | 'unavailable';

export type HostAppSource = 'installed' | 'developer';

export type HostAppStatusReason =
  | 'available'
  | 'localOriginUnavailable'
  | 'metadataMissing'
  | 'metadataInvalid'
  | 'uiPortMissing'
  | 'uiPortNotPublic'
  | 'moduleOperationUnavailable'
  | 'runtimeUnavailable';

export type HostAppOriginScope = 'local' | 'public';

export interface HostAppNavigationItem {
  label: string;
  path: string;
  entryPath: string;
  embeddedUrl: string;
}

export interface HostAppEntry {
  id: string;
  source: HostAppSource;
  moduleId: string;
  developerTargetId?: string;
  displayName: string;
  description?: string;
  icon?: string;
  version: string;
  status: HostAppStatus;
  statusReason: HostAppStatusReason;
  accessMode: HostAppAccessMode;
  operationStatus?: ModuleOperationStatus;
  lastOperation?: InstalledModuleRecord['lastOperation'];
  runtimeState?: ModuleRuntimeState;
  entryPath: string;
  embeddedUrl: string;
  origin: string | null;
  originScope?: HostAppOriginScope;
  identityTokenUrl: string | null;
  navigation: HostAppNavigationItem[];
}

export interface HostAppsResponse {
  apps: HostAppEntry[];
}
