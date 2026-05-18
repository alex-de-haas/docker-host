import { getHostRuntimeConfig } from './host-runtime.ts';
import type { HostRuntimeConfig } from './host-runtime.ts';
import { readAuthState } from './auth-store.ts';
import type {
  AuthOidcProviderRecord,
  AuthTrustedProxyProviderRecord,
} from './auth-store.ts';

export type AuthDiagnosticStatus = 'pass' | 'warn' | 'fail' | 'info';

export interface AuthDiagnosticCheck {
  id: string;
  label: string;
  status: AuthDiagnosticStatus;
  message: string;
  nextStep?: string;
}

export interface AuthDiagnosticsReport {
  generatedAt: string;
  oidc: AuthDiagnosticCheck[];
  trustedProxy: AuthDiagnosticCheck[];
}

export async function getAuthDiagnostics(
  config: HostRuntimeConfig = getHostRuntimeConfig()
): Promise<AuthDiagnosticsReport> {
  const state = await readAuthState(config);
  const oidcProviders = [
    ...state.oidcProviders.filter(provider => provider.enabled),
    ...getEnvOidcProviders(),
  ];
  const trustedProxyProviders = [
    ...state.trustedProxyProviders.filter(provider => provider.enabled),
    ...getEnvTrustedProxyProviders(),
  ];

  return {
    generatedAt: new Date().toISOString(),
    oidc: [
      ...diagnoseProviderCount('oidc.provider.count', 'OIDC active providers', oidcProviders.length),
      ...oidcProviders.flatMap(diagnoseOidcProvider),
    ],
    trustedProxy: [
      ...diagnoseProviderCount('trusted_proxy.provider.count', 'Trusted proxy active providers', trustedProxyProviders.length),
      ...trustedProxyProviders.flatMap(diagnoseTrustedProxyProvider),
    ],
  };
}

function diagnoseProviderCount(id: string, label: string, count: number): AuthDiagnosticCheck[] {
  if (count === 0) {
    return [{
      id,
      label,
      status: 'info',
      message: 'No active provider is configured.',
    }];
  }

  if (count === 1) {
    return [{
      id,
      label,
      status: 'pass',
      message: 'Exactly one active provider is configured.',
    }];
  }

  return [{
    id,
    label,
    status: 'fail',
    message: `${count} active providers are configured, but only one is supported.`,
    nextStep: 'Disable all but one provider.',
  }];
}

function diagnoseOidcProvider(provider: AuthOidcProviderRecord): AuthDiagnosticCheck[] {
  const prefix = `oidc.${provider.id}`;
  return [
    checkAbsoluteUrl(`${prefix}.issuer`, 'OIDC issuer', provider.issuer, 'Configure HOST_OIDC_ISSUER or the provider issuer as an absolute URL.'),
    checkRequired(`${prefix}.client_id`, 'OIDC client id', provider.clientId, 'Configure HOST_OIDC_CLIENT_ID or the provider client id.'),
    {
      id: `${prefix}.scopes`,
      label: 'OIDC scopes',
      status: provider.scopes.includes('openid') ? 'pass' : 'fail',
      message: provider.scopes.includes('openid')
        ? `Configured scopes: ${provider.scopes.join(', ')}.`
        : 'OIDC scopes do not include openid.',
      nextStep: provider.scopes.includes('openid') ? undefined : 'Add openid to the configured scopes.',
    },
    {
      id: `${prefix}.role_mappings`,
      label: 'OIDC role mappings',
      status: provider.roleMappings.length > 0 ? 'pass' : 'fail',
      message: provider.roleMappings.length > 0
        ? `${provider.roleMappings.length} role mapping${provider.roleMappings.length === 1 ? '' : 's'} configured.`
        : 'No role mappings are configured.',
      nextStep: provider.roleMappings.length > 0 ? undefined : 'Configure admin or user group mappings.',
    },
    {
      id: `${prefix}.callback`,
      label: 'OIDC callback URL',
      status: provider.callbackUrl ? 'pass' : 'warn',
      message: provider.callbackUrl
        ? 'An explicit callback URL is configured.'
        : 'No explicit callback URL is configured; Host will derive it from HOST_PUBLIC_ORIGIN or the request origin.',
      nextStep: provider.callbackUrl ? undefined : 'Set HOST_PUBLIC_ORIGIN or HOST_OIDC_CALLBACK_URL for non-loopback deployments.',
    },
    {
      id: `${prefix}.discovery`,
      label: 'OIDC discovery',
      status: 'info',
      message: 'Remote discovery is checked during login.',
      nextStep: 'If login fails, verify /.well-known/openid-configuration and provider JWKS reachability from the Host container.',
    },
  ];
}

function diagnoseTrustedProxyProvider(provider: AuthTrustedProxyProviderRecord): AuthDiagnosticCheck[] {
  const prefix = `trusted_proxy.${provider.id}`;
  const audience = Array.isArray(provider.audience) ? provider.audience : [provider.audience];
  return [
    checkAbsoluteUrl(`${prefix}.issuer`, 'Trusted proxy issuer', provider.issuer, 'Configure a signed assertion issuer.'),
    checkRequired(`${prefix}.assertion_header`, 'Trusted proxy assertion header', provider.assertionHeader, 'Configure the assertion header name.'),
    {
      id: `${prefix}.audience`,
      label: 'Trusted proxy audience',
      status: audience.filter(Boolean).length > 0 ? 'pass' : 'fail',
      message: audience.filter(Boolean).length > 0
        ? `${audience.length} audience value${audience.length === 1 ? '' : 's'} configured.`
        : 'No accepted audience is configured.',
      nextStep: audience.filter(Boolean).length > 0 ? undefined : 'Configure HOST_TRUSTED_PROXY_AUDIENCE or provider audience.',
    },
    {
      id: `${prefix}.jwks`,
      label: 'Trusted proxy JWKS',
      status: provider.jwks || provider.jwksUri ? 'pass' : 'fail',
      message: provider.jwks
        ? 'Inline JWKS is configured.'
        : provider.jwksUri
          ? 'JWKS URI is configured.'
          : 'No JWKS source is configured.',
      nextStep: provider.jwks || provider.jwksUri ? undefined : 'Configure inline JWKS or JWKS URI.',
    },
    {
      id: `${prefix}.role_mappings`,
      label: 'Trusted proxy role mappings',
      status: provider.roleMappings.length > 0 ? 'pass' : 'fail',
      message: provider.roleMappings.length > 0
        ? `${provider.roleMappings.length} role mapping${provider.roleMappings.length === 1 ? '' : 's'} configured.`
        : 'No role mappings are configured.',
      nextStep: provider.roleMappings.length > 0 ? undefined : 'Configure admin or user group mappings.',
    },
  ];
}

function checkRequired(id: string, label: string, value: string | undefined, nextStep: string): AuthDiagnosticCheck {
  return value?.trim()
    ? {
        id,
        label,
        status: 'pass',
        message: 'Configured.',
      }
    : {
        id,
        label,
        status: 'fail',
        message: 'Missing required value.',
        nextStep,
      };
}

function checkAbsoluteUrl(id: string, label: string, value: string | undefined, nextStep: string): AuthDiagnosticCheck {
  if (!value?.trim()) {
    return {
      id,
      label,
      status: 'fail',
      message: 'Missing required URL.',
      nextStep,
    };
  }

  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? {
          id,
          label,
          status: 'pass',
          message: value,
        }
      : {
          id,
          label,
          status: 'fail',
          message: 'URL must use http or https.',
          nextStep,
        };
  } catch {
    return {
      id,
      label,
      status: 'fail',
      message: 'Invalid URL.',
      nextStep,
    };
  }
}

function getEnvOidcProviders(): AuthOidcProviderRecord[] {
  if (process.env.HOST_OIDC_ENABLED?.trim().toLowerCase() === 'false') {
    return [];
  }

  const issuer = normalizeIssuer(process.env.HOST_OIDC_ISSUER);
  const clientId = process.env.HOST_OIDC_CLIENT_ID?.trim();
  if (!issuer && !clientId) {
    return [];
  }

  const now = new Date().toISOString();
  const groupClaim = process.env.HOST_OIDC_GROUPS_CLAIM?.trim() || 'groups';
  return [{
    id: 'env',
    type: 'oidc',
    enabled: true,
    label: process.env.HOST_OIDC_LABEL?.trim() || 'OIDC',
    issuer,
    clientId: clientId || '',
    clientSecret: process.env.HOST_OIDC_CLIENT_SECRET?.trim() || undefined,
    callbackUrl: process.env.HOST_OIDC_CALLBACK_URL?.trim() || undefined,
    scopes: splitList(process.env.HOST_OIDC_SCOPES).length > 0
      ? splitList(process.env.HOST_OIDC_SCOPES)
      : ['openid', 'profile', 'email'],
    roleMappings: [
      ...splitList(process.env.HOST_OIDC_ADMIN_GROUPS).map(value => ({ claim: groupClaim, values: [value], role: 'host.admin' as const })),
      ...splitList(process.env.HOST_OIDC_USER_GROUPS).map(value => ({ claim: groupClaim, values: [value], role: 'host.user' as const })),
    ],
    createdAt: now,
    updatedAt: now,
  }];
}

function getEnvTrustedProxyProviders(): AuthTrustedProxyProviderRecord[] {
  if (process.env.HOST_TRUSTED_PROXY_ENABLED?.trim().toLowerCase() === 'false') {
    return [];
  }

  const audience = splitList(process.env.HOST_TRUSTED_PROXY_AUDIENCE);
  const cloudflareTeamDomain = process.env.HOST_TRUSTED_PROXY_CLOUDFLARE_TEAM_DOMAIN?.trim();
  const issuer = cloudflareTeamDomain
    ? `https://${cloudflareTeamDomain.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`
    : normalizeIssuer(process.env.HOST_TRUSTED_PROXY_ISSUER);
  const jwksUri = process.env.HOST_TRUSTED_PROXY_JWKS_URI?.trim() ||
    (cloudflareTeamDomain ? `${issuer}/cdn-cgi/access/certs` : undefined);
  const inlineJwks = parseJsonWebKeySet(process.env.HOST_TRUSTED_PROXY_JWKS);
  if (!issuer && audience.length === 0 && !jwksUri && !inlineJwks) {
    return [];
  }

  const now = new Date().toISOString();
  const groupClaim = process.env.HOST_TRUSTED_PROXY_GROUPS_CLAIM?.trim() || 'groups';
  return [{
    id: 'env',
    type: 'trusted-proxy',
    enabled: true,
    label: process.env.HOST_TRUSTED_PROXY_LABEL?.trim() || (cloudflareTeamDomain ? 'Cloudflare Access' : 'Trusted proxy'),
    issuer,
    audience,
    assertionHeader: process.env.HOST_TRUSTED_PROXY_ASSERTION_HEADER?.trim() ||
      (cloudflareTeamDomain ? 'Cf-Access-Jwt-Assertion' : 'X-Docker-Host-Trusted-Proxy-Jwt'),
    jwks: inlineJwks,
    jwksUri,
    subjectClaim: process.env.HOST_TRUSTED_PROXY_SUBJECT_CLAIM?.trim() || 'sub',
    emailClaim: process.env.HOST_TRUSTED_PROXY_EMAIL_CLAIM?.trim() || 'email',
    displayNameClaim: process.env.HOST_TRUSTED_PROXY_DISPLAY_NAME_CLAIM?.trim() || 'name',
    roleMappings: [
      ...splitList(process.env.HOST_TRUSTED_PROXY_ADMIN_GROUPS).map(value => ({ claim: groupClaim, values: [value], role: 'host.admin' as const })),
      ...splitList(process.env.HOST_TRUSTED_PROXY_USER_GROUPS).map(value => ({ claim: groupClaim, values: [value], role: 'host.user' as const })),
    ],
    createdAt: now,
    updatedAt: now,
  }];
}

function parseJsonWebKeySet(value: string | undefined): { keys: JsonWebKey[] } | undefined {
  if (!value?.trim()) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return isObject(parsed) && Array.isArray(parsed.keys) ? parsed as { keys: JsonWebKey[] } : undefined;
  } catch {
    return undefined;
  }
}

function normalizeIssuer(value: string | undefined) {
  return value?.trim().replace(/\/+$/, '') || '';
}

function splitList(value: string | undefined) {
  return value
    ? value.split(/[,\s]+/).map(item => item.trim()).filter(Boolean)
    : [];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
