import type { InstalledModuleRecord, ModuleOperationStatus, ModuleRuntimeState } from './modules';

export type HostAppAccessMode = 'allAuthenticated' | 'assignedUsersOnly';

export type HostAppStatus = 'available' | 'unavailable';

export type HostAppSource = 'system' | 'installed';

export type HostAppKind = 'system' | 'runtime';

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
  kind: HostAppKind;
  system: boolean;
  source: HostAppSource;
  moduleId: string;
  displayName: string;
  description?: string;
  icon?: string;
  version: string;
  status: HostAppStatus;
  statusReason: HostAppStatusReason;
  accessMode: HostAppAccessMode;
  capabilities: string[];
  selectedChannel?: string;
  selectedRuntime?: string;
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
