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

export interface GatewayExposureOptionPort {
  key: string;
  containerPort: number;
  protocol: string;
  public: boolean;
  isUiEntrypoint: boolean;
}

export interface GatewayExposureOptionModule {
  id: string;
  name: string;
  description?: string;
  operationStatus?: string;
  uiEntrypointPortKey?: string;
  ports: GatewayExposureOptionPort[];
}

export interface GatewayExposureOptionUser {
  id: string;
  displayName?: string;
  email?: string;
  role: 'host.admin' | 'host.user';
}

export interface GatewayExposureOptions {
  gatewayBaseDomain: string | null;
  hostPublicOrigin: string | null;
  modules: GatewayExposureOptionModule[];
  users: GatewayExposureOptionUser[];
}
