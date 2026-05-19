import type { JSONWebKeySet, JWTPayload } from 'jose';
import type { HostPrincipal, HostRole } from '../types/auth';
import type { HostRuntimeConfig } from './host-runtime';
import type { AuthExternalIdentityRecord } from './auth-store';

export const TRUSTED_PROXY_DEFAULT_ASSERTION_HEADERS: readonly string[];

export interface TrustedProxyRoleMapping {
  claim: string;
  values: string[];
  role: HostRole;
}

export interface TrustedProxyProvider {
  id: string;
  type: 'trusted-proxy';
  enabled: boolean;
  label: string;
  issuer: string;
  audience: string | string[];
  assertionHeader: string;
  jwks?: JSONWebKeySet;
  jwksUri?: string;
  subjectClaim?: string;
  emailClaim?: string;
  displayNameClaim?: string;
  roleMappings: TrustedProxyRoleMapping[];
  createdAt: string;
  updatedAt: string;
}

export interface TrustedProxyAuthResult {
  modeActive: boolean;
  principal: HostPrincipal | null;
  source: 'trusted-proxy';
  reason?: string;
  provider?: {
    id: string;
    label: string;
  };
  assertionHeaders: string[];
  externalIdentity?: AuthExternalIdentityRecord;
  provisioned?: boolean;
}

export class TrustedProxyServiceError extends Error {
  code: string;
}

export function getTrustedProxyModeStatus(
  config?: HostRuntimeConfig
): Promise<{
  enabled: boolean;
  assertionHeaders: string[];
}>;

export function getTrustedProxyAssertionHeaderNames(
  config?: HostRuntimeConfig
): Promise<string[]>;

export function authenticateTrustedProxyRequest(
  request: Request | { headers?: Record<string, string | string[] | undefined> },
  config?: HostRuntimeConfig
): Promise<TrustedProxyAuthResult>;

export function mapTrustedProxyRole(
  mappings: TrustedProxyRoleMapping[],
  claims: JWTPayload
): HostRole | null;
