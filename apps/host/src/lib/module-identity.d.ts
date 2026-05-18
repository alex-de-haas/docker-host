import type { HostRuntimeConfig } from './host-runtime';
import type { HostPrincipal, ModuleAccessDecision, ModuleExposurePolicy } from '../types/auth';
import type { GatewayExposureRecord, ModuleIdentityMode } from '../types/gateway';

export const MODULE_IDENTITY_SCHEMA_VERSION: '0.1';
export const MODULE_IDENTITY_ISSUER: 'docker-host';
export const MODULE_IDENTITY_ALGORITHM: 'ES256';
export const MODULE_IDENTITY_TOKEN_HEADER: 'X-Docker-Host-Identity';
export const MODULE_IDENTITY_TOKEN_TTL_SECONDS: number;

export interface ModuleIdentityTokenInput {
  principal: HostPrincipal | null | undefined;
  access: ModuleAccessDecision;
  exposure: Pick<GatewayExposureRecord, 'id' | 'moduleId' | 'hostname' | 'portKey' | 'exposurePolicy'> & {
    identityMode?: ModuleIdentityMode;
  };
}

export interface ModuleIdentityDiscovery {
  issuer: string;
  jwks_uri: string;
  token_header: string;
  algorithms: string[];
  token_ttl_seconds: number;
  audience: string;
}

export function getModuleIdentityJwks(config: HostRuntimeConfig): Promise<{ keys: object[] }>;
export function getModuleIdentityDiscovery(config: HostRuntimeConfig, requestOrigin?: string): ModuleIdentityDiscovery;
export function createModuleIdentityToken(
  input: ModuleIdentityTokenInput,
  config: HostRuntimeConfig,
  now?: Date
): Promise<string | null>;
export function shouldIssueModuleIdentity(input: ModuleIdentityTokenInput): boolean;
export function getExposureIdentityMode(exposure: { exposurePolicy: ModuleExposurePolicy; identityMode?: ModuleIdentityMode }): ModuleIdentityMode;
export function getDefaultModuleIdentityMode(exposurePolicy: ModuleExposurePolicy): ModuleIdentityMode;
export function isModuleIdentityMode(value: unknown): value is ModuleIdentityMode;
export function getModuleAccessClaim(input: ModuleIdentityTokenInput): 'authenticated' | 'assigned' | 'hostAdmin' | 'publicAuthenticated';
export function readModuleIdentityKeyStoreSnapshot(config: HostRuntimeConfig): Promise<object>;
export function ensureModuleIdentityKeyStore(config: HostRuntimeConfig): Promise<object>;
