import type { ModuleExposurePolicy } from './auth';
import type { ModuleIdentityMode } from './gateway';

export interface ModuleDevTargetRecord {
  id: string;
  moduleId: string;
  moduleName: string;
  moduleVersion: string;
  moduleDescription?: string;
  metadataUrl: string;
  hostname: string;
  portKey: string;
  targetBaseUrl: string;
  targetPathPrefix: string;
  containerPort: number;
  protocol: string;
  exposurePolicy: ModuleExposurePolicy;
  identityMode: ModuleIdentityMode;
  enabled: boolean;
  shellApp?: ModuleDevTargetShellApp;
  createdAt: string;
  updatedAt: string;
}

export interface ModuleDevTargetShellApp {
  displayName: string;
  description?: string;
  icon?: string;
  entrypointPath: string;
  navigation: ModuleDevTargetShellNavigationItem[];
}

export interface ModuleDevTargetShellNavigationItem {
  label: string;
  path: string;
}

export interface ModuleDevTargetState {
  schemaVersion: '0.1';
  targets: ModuleDevTargetRecord[];
  updatedAt: string;
}

export interface ModuleDevTargetInput {
  metadataUrl: string;
  hostname: string;
  portKey: string;
  targetBaseUrl: string;
  exposurePolicy?: ModuleExposurePolicy;
  identityMode?: ModuleIdentityMode;
  enabled?: boolean;
}
