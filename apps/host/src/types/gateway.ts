import type { ModuleExposurePolicy } from './auth';

export type ModuleIdentityMode = 'none' | 'optional' | 'required';

export interface GatewayExposureRecord {
  id: string;
  moduleId: string;
  hostname: string;
  endpointKey: string;
  exposurePolicy: ModuleExposurePolicy;
  identityMode: ModuleIdentityMode;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface GatewayExposureState {
  schemaVersion: '0.2';
  exposures: GatewayExposureRecord[];
  updatedAt: string;
}

export interface GatewayExposureInput {
  moduleId: string;
  hostname: string;
  endpointKey?: string;
  portKey?: string;
  exposurePolicy?: ModuleExposurePolicy;
  identityMode?: ModuleIdentityMode;
  enabled?: boolean;
}
