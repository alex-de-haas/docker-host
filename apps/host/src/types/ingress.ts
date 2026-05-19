import type { GatewayExposureRecord } from './gateway';

export type ExternalIngressMode = 'manual';

export type ExternalIngressStatus =
  | 'unmanaged'
  | 'planned'
  | 'manualReady'
  | 'validated'
  | 'drifted'
  | 'failed'
  | 'unknown';

export interface ExternalIngressChecklist {
  dnsConfigured?: boolean;
  reverseProxyConfigured?: boolean;
  tlsConfigured?: boolean;
  websocketForwarding?: boolean;
  authProviderConfigured?: boolean;
  directOriginProtected?: boolean;
}

export interface ExternalIngressSnapshot {
  moduleId: string;
  hostname: string;
  portKey: string;
  exposurePolicy: GatewayExposureRecord['exposurePolicy'];
  identityMode: GatewayExposureRecord['identityMode'];
  gatewayBaseDomain: string | null;
  hostPublicOrigin: string | null;
  trustedProxyMode: boolean;
}

export interface ExternalIngressValidationCheck {
  code: string;
  label: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
  nextStep?: string;
}

export interface ExternalIngressValidationResult {
  checkedAt: string;
  status: ExternalIngressStatus;
  checks: ExternalIngressValidationCheck[];
  drift: string[];
}

export interface ExternalIngressRecord {
  id: string;
  gatewayExposureId: string;
  mode: ExternalIngressMode;
  status: ExternalIngressStatus;
  checklist: ExternalIngressChecklist;
  notes?: string;
  snapshot: ExternalIngressSnapshot;
  lastValidation?: ExternalIngressValidationResult;
  markedReadyAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalIngressState {
  schemaVersion: '0.1';
  records: ExternalIngressRecord[];
  updatedAt: string;
}

export interface ExternalIngressInstruction {
  title: string;
  body: string;
  value?: string;
}

export interface ExternalIngressStatusItem {
  exposure: GatewayExposureRecord & { assignedUserIds?: string[] };
  record: ExternalIngressRecord | null;
  status: ExternalIngressStatus;
  instructions: ExternalIngressInstruction[];
  validation: ExternalIngressValidationResult | null;
  nextStep: string;
}

export interface ExternalIngressIntentInput {
  gatewayExposureId: string;
  checklist?: ExternalIngressChecklist;
  notes?: string;
  markReady?: boolean;
}
