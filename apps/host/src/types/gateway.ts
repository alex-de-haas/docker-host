import type { ModuleExposurePolicy } from './auth';

export interface GatewayExposureRecord {
  id: string;
  moduleId: string;
  hostname: string;
  portKey: string;
  exposurePolicy: ModuleExposurePolicy;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface GatewayExposureState {
  schemaVersion: '0.1';
  exposures: GatewayExposureRecord[];
  updatedAt: string;
}

export interface GatewayExposureInput {
  moduleId: string;
  hostname: string;
  portKey: string;
  exposurePolicy?: ModuleExposurePolicy;
  enabled?: boolean;
}
