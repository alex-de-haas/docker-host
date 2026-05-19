import type { ModuleOperationStatus, ModuleRuntimeState } from './modules';

export type HostAppAccessMode = 'allAuthenticated' | 'assignedUsersOnly';

export type HostAppStatus = 'available' | 'unavailable';

export type HostAppStatusReason =
  | 'available'
  | 'metadataMissing'
  | 'metadataInvalid'
  | 'uiPortMissing'
  | 'uiPortNotPublic'
  | 'moduleOperationUnavailable'
  | 'runtimeUnavailable';

export interface HostAppNavigationItem {
  label: string;
  path: string;
  entryPath: string;
  embeddedUrl: string;
}

export interface HostAppEntry {
  id: string;
  moduleId: string;
  displayName: string;
  description?: string;
  icon?: string;
  version: string;
  status: HostAppStatus;
  statusReason: HostAppStatusReason;
  accessMode: HostAppAccessMode;
  operationStatus?: ModuleOperationStatus;
  runtimeState?: ModuleRuntimeState;
  entryPath: string;
  embeddedUrl: string;
  navigation: HostAppNavigationItem[];
}

export interface HostAppsResponse {
  apps: HostAppEntry[];
}
