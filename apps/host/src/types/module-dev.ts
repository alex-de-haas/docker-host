import type { ModuleExposurePolicy } from './auth';
import type { ModuleIdentityMode } from './gateway';

export interface ModuleDevTargetRecord {
  id: string;
  moduleId: string;
  moduleName: string;
  moduleVersion: string;
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
  createdAt: string;
  updatedAt: string;
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
