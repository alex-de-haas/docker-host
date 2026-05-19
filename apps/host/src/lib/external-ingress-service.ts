import { randomUUID } from 'node:crypto';
import { appendAuthAuditEvent, readAuthStateSnapshot } from './auth-store.ts';
import { getHostRuntimeConfig } from './host-runtime.ts';
import type { HostRuntimeConfig } from './host-runtime.ts';
import { listGatewayExposures } from './gateway-service.ts';
import {
  readExternalIngressStateSnapshot,
  updateExternalIngressState,
} from './external-ingress-store.ts';
import type { GatewayExposureRecord } from '../types/gateway.ts';
import type {
  ExternalIngressChecklist,
  ExternalIngressInstruction,
  ExternalIngressIntentInput,
  ExternalIngressRecord,
  ExternalIngressSnapshot,
  ExternalIngressStatus,
  ExternalIngressStatusItem,
  ExternalIngressValidationCheck,
  ExternalIngressValidationResult,
} from '../types/ingress.ts';

export class ExternalIngressServiceError extends Error {
  public readonly code: string;
  public readonly status: number;

  public constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'ExternalIngressServiceError';
    this.code = code;
    this.status = status;
  }
}

export async function listExternalIngressReadiness(
  config = getHostRuntimeConfig()
): Promise<ExternalIngressStatusItem[]> {
  const [exposures, state, trustedProxyMode] = await Promise.all([
    listGatewayExposures(config),
    readExternalIngressStateSnapshot(config),
    hasTrustedProxyMode(config),
  ]);

  return exposures.map(exposure => {
    const record = state.records.find(candidate => candidate.gatewayExposureId === exposure.id) ?? null;
    return buildStatusItem(exposure, record, trustedProxyMode, config);
  });
}

export async function getExternalIngressReadiness(
  gatewayExposureId: string,
  config = getHostRuntimeConfig()
): Promise<ExternalIngressStatusItem> {
  const exposure = await requireGatewayExposure(gatewayExposureId, config);
  const [state, trustedProxyMode] = await Promise.all([
    readExternalIngressStateSnapshot(config),
    hasTrustedProxyMode(config),
  ]);
  const record = state.records.find(candidate => candidate.gatewayExposureId === exposure.id) ?? null;
  return buildStatusItem(exposure, record, trustedProxyMode, config);
}

export async function upsertExternalIngressIntent(
  input: ExternalIngressIntentInput,
  actorUserId?: string,
  config = getHostRuntimeConfig()
): Promise<ExternalIngressStatusItem> {
  const exposure = await requireEligibleGatewayExposure(input.gatewayExposureId, config);
  const trustedProxyMode = await hasTrustedProxyMode(config);
  const now = new Date().toISOString();
  const snapshot = createSnapshot(exposure, trustedProxyMode, config);
  const checklist = normalizeChecklist(input.checklist);

  const record = await updateExternalIngressState(state => {
    const existing = state.records.find(candidate => candidate.gatewayExposureId === exposure.id) ?? null;
    const nextRecord: ExternalIngressRecord = existing
      ? {
          ...existing,
          checklist: {
            ...existing.checklist,
            ...checklist,
          },
          ...(typeof input.notes === 'string' ? { notes: input.notes } : {}),
          snapshot,
          status: input.markReady ? 'manualReady' : existing.status === 'unmanaged' ? 'planned' : existing.status,
          ...(input.markReady ? { markedReadyAt: now } : {}),
          updatedAt: now,
        }
      : {
          id: `ing_${randomUUID()}`,
          gatewayExposureId: exposure.id,
          mode: 'manual',
          status: input.markReady ? 'manualReady' : 'planned',
          checklist,
          ...(typeof input.notes === 'string' ? { notes: input.notes } : {}),
          snapshot,
          ...(input.markReady ? { markedReadyAt: now } : {}),
          createdAt: now,
          updatedAt: now,
        };

    return {
      state: {
        ...state,
        records: existing
          ? state.records.map(candidate => candidate.id === existing.id ? nextRecord : candidate)
          : [...state.records, nextRecord],
      },
      result: nextRecord,
    };
  }, config);

  await appendAuthAuditEvent({
    type: input.markReady ? 'ingress.manual.marked_ready' : 'ingress.manual.intent.saved',
    actorUserId,
    target: {
      type: 'gateway.exposure',
      id: exposure.id,
    },
    success: true,
    details: {
      gatewayExposureId: exposure.id,
      moduleId: exposure.moduleId,
      hostname: exposure.hostname,
      status: record.status,
    },
  }, config);

  return buildStatusItem(exposure, record, trustedProxyMode, config);
}

export async function refreshExternalIngressReadiness(
  gatewayExposureId: string,
  actorUserId?: string,
  config = getHostRuntimeConfig()
): Promise<ExternalIngressStatusItem> {
  const exposure = await requireGatewayExposure(gatewayExposureId, config);
  const trustedProxyMode = await hasTrustedProxyMode(config);
  const now = new Date().toISOString();

  const { record, validation } = await updateExternalIngressState(state => {
    const existing = state.records.find(candidate => candidate.gatewayExposureId === exposure.id) ?? null;
    if (!existing) {
      throw new ExternalIngressServiceError(
        'ingress_intent_not_found',
        `External ingress intent for exposure "${gatewayExposureId}" was not found.`,
        404
      );
    }

    const nextValidation = validateIngressReadiness(exposure, existing, trustedProxyMode, config, now);
    const nextRecord: ExternalIngressRecord = {
      ...existing,
      snapshot: nextValidation.drift.length > 0
        ? existing.snapshot
        : createSnapshot(exposure, trustedProxyMode, config),
      status: nextValidation.status,
      lastValidation: nextValidation,
      updatedAt: now,
    };

    return {
      state: {
        ...state,
        records: state.records.map(candidate => candidate.id === existing.id ? nextRecord : candidate),
      },
      result: {
        record: nextRecord,
        validation: nextValidation,
      },
    };
  }, config);

  await appendAuthAuditEvent({
    type: validation.status === 'drifted'
      ? 'ingress.manual.drift_detected'
      : 'ingress.manual.validation.refreshed',
    actorUserId,
    target: {
      type: 'gateway.exposure',
      id: exposure.id,
    },
    success: validation.status !== 'failed',
    details: {
      gatewayExposureId: exposure.id,
      moduleId: exposure.moduleId,
      hostname: exposure.hostname,
      status: validation.status,
      drift: validation.drift,
    },
  }, config);

  return buildStatusItem(exposure, record, trustedProxyMode, config);
}

export async function unlinkExternalIngressIntent(
  gatewayExposureId: string,
  actorUserId?: string,
  config = getHostRuntimeConfig()
): Promise<ExternalIngressRecord | null> {
  const exposure = await requireGatewayExposure(gatewayExposureId, config);
  const deleted = await updateExternalIngressState(state => {
    const record = state.records.find(candidate => candidate.gatewayExposureId === exposure.id) ?? null;
    return {
      state: {
        ...state,
        records: state.records.filter(candidate => candidate.gatewayExposureId !== exposure.id),
      },
      result: record,
    };
  }, config);

  if (deleted) {
    await appendAuthAuditEvent({
      type: 'ingress.manual.unlinked',
      actorUserId,
      target: {
        type: 'gateway.exposure',
        id: exposure.id,
      },
      success: true,
      details: {
        gatewayExposureId: exposure.id,
        moduleId: exposure.moduleId,
        hostname: exposure.hostname,
        status: deleted.status,
      },
    }, config);
  }

  return deleted;
}

export function isExternalIngressServiceError(error: unknown): error is ExternalIngressServiceError {
  return error instanceof ExternalIngressServiceError;
}

async function requireGatewayExposure(
  gatewayExposureId: string,
  config: HostRuntimeConfig
) {
  const exposures = await listGatewayExposures(config);
  const exposure = exposures.find(candidate => candidate.id === gatewayExposureId);
  if (!exposure) {
    throw new ExternalIngressServiceError(
      'gateway_exposure_not_found',
      `Gateway exposure "${gatewayExposureId}" was not found.`,
      404
    );
  }

  return exposure;
}

async function requireEligibleGatewayExposure(
  gatewayExposureId: string,
  config: HostRuntimeConfig
) {
  const exposure = await requireGatewayExposure(gatewayExposureId, config);

  if (!exposure.enabled) {
    throw new ExternalIngressServiceError(
      'gateway_exposure_disabled',
      `Gateway exposure "${gatewayExposureId}" must be enabled before external ingress can be planned.`
    );
  }

  if (!config.gatewayBaseDomain) {
    throw new ExternalIngressServiceError(
      'gateway_base_domain_required',
      'HOST_GATEWAY_BASE_DOMAIN is required before external ingress can be planned.'
    );
  }

  const normalizedBaseDomain = normalizeHostname(config.gatewayBaseDomain);
  if (!exposure.hostname.endsWith(`.${normalizedBaseDomain}`)) {
    throw new ExternalIngressServiceError(
      'gateway_hostname_outside_base_domain',
      `Hostname "${exposure.hostname}" is outside HOST_GATEWAY_BASE_DOMAIN "${normalizedBaseDomain}".`
    );
  }

  return exposure;
}

function buildStatusItem(
  exposure: GatewayExposureRecord & { assignedUserIds?: string[] },
  record: ExternalIngressRecord | null,
  trustedProxyMode: boolean,
  config: HostRuntimeConfig
): ExternalIngressStatusItem {
  const instructions = buildInstructions(exposure, trustedProxyMode, config);
  const status = record?.status ?? 'unmanaged';
  return {
    exposure,
    record,
    status,
    instructions,
    validation: record?.lastValidation ?? null,
    nextStep: getNextStep(status, record, config),
  };
}

function buildInstructions(
  exposure: Pick<GatewayExposureRecord, 'hostname' | 'exposurePolicy' | 'identityMode'>,
  trustedProxyMode: boolean,
  config: HostRuntimeConfig
): ExternalIngressInstruction[] {
  const hostOrigin = config.hostPublicOrigin ?? 'Set HOST_PUBLIC_ORIGIN to the external Host origin.';
  const callbackUrl = config.hostPublicOrigin
    ? `${config.hostPublicOrigin.replace(/\/+$/, '')}/api/auth/oidc/callback`
    : 'Set HOST_PUBLIC_ORIGIN first, then use /api/auth/oidc/callback on that origin.';

  return [
    {
      title: 'DNS',
      body: `Create a DNS record for ${exposure.hostname} that reaches the reverse proxy or tunnel in front of Docker Host.`,
      value: exposure.hostname,
    },
    {
      title: 'Reverse proxy',
      body: 'Route HTTP, streaming responses, SSE, and WebSocket upgrades for this hostname to the Docker Host origin. Preserve Host and X-Forwarded-* headers, and do not forward Docker Host session cookies to module upstreams.',
      value: hostOrigin,
    },
    {
      title: 'TLS',
      body: 'Use HTTPS for non-loopback deployments so Host browser sessions can use secure cookies.',
    },
    {
      title: 'OIDC callback',
      body: 'If browser login is owned by Docker Host OIDC, configure the identity provider with this callback URL.',
      value: callbackUrl,
    },
    {
      title: 'Trusted proxy',
      body: trustedProxyMode
        ? 'Trusted proxy mode is enabled. The upstream proxy must send a signed assertion in the configured assertion header and direct browser session fallback must be blocked.'
        : 'If an upstream proxy owns authentication, configure Docker Host generic trusted proxy mode with issuer, audience, assertion header, JWKS, and role mappings.',
    },
    {
      title: 'Gateway policy',
      body: `Docker Host remains the authorization boundary for this exposure: policy ${exposure.exposurePolicy}, identity mode ${exposure.identityMode}.`,
    },
  ];
}

function validateIngressReadiness(
  exposure: GatewayExposureRecord,
  record: ExternalIngressRecord,
  trustedProxyMode: boolean,
  config: HostRuntimeConfig,
  checkedAt: string
): ExternalIngressValidationResult {
  const snapshot = createSnapshot(exposure, trustedProxyMode, config);
  const drift = getDrift(record.snapshot, snapshot);
  const checks: ExternalIngressValidationCheck[] = [
    check(Boolean(config.gatewayBaseDomain), {
      code: 'gateway_base_domain',
      label: 'Gateway base domain',
      pass: `HOST_GATEWAY_BASE_DOMAIN is ${config.gatewayBaseDomain}.`,
      fail: 'HOST_GATEWAY_BASE_DOMAIN is not configured.',
      nextStep: 'Set HOST_GATEWAY_BASE_DOMAIN before publishing gateway subdomains.',
    }),
    check(Boolean(config.hostPublicOrigin), {
      code: 'host_public_origin',
      label: 'Host public origin',
      pass: `HOST_PUBLIC_ORIGIN is ${config.hostPublicOrigin}.`,
      fail: 'HOST_PUBLIC_ORIGIN is not configured.',
      nextStep: 'Set HOST_PUBLIC_ORIGIN to the external Host UI origin.',
    }),
    check(exposure.enabled, {
      code: 'gateway_exposure_enabled',
      label: 'Gateway exposure',
      pass: 'Gateway exposure is enabled.',
      fail: 'Gateway exposure is disabled.',
      nextStep: 'Enable the gateway exposure before marking ingress ready.',
    }),
    check(isHttpsOrLoopback(config.hostPublicOrigin), {
      code: 'secure_public_origin',
      label: 'Secure public origin',
      pass: 'Public origin is HTTPS or loopback.',
      fail: 'Non-loopback public origins must use HTTPS.',
      nextStep: 'Serve Docker Host through HTTPS before external browser traffic uses it.',
    }),
    checklistCheck(record.checklist.dnsConfigured, {
      code: 'manual_dns',
      label: 'DNS configured',
      message: 'DNS is marked configured.',
      nextStep: 'Create or validate the DNS record for the exposure hostname.',
    }),
    checklistCheck(record.checklist.reverseProxyConfigured, {
      code: 'manual_reverse_proxy',
      label: 'Reverse proxy configured',
      message: 'Reverse proxy routing is marked configured.',
      nextStep: 'Route the exposure hostname to Docker Host through the external proxy.',
    }),
    checklistCheck(record.checklist.tlsConfigured, {
      code: 'manual_tls',
      label: 'TLS configured',
      message: 'TLS is marked configured.',
      nextStep: 'Configure HTTPS for the external hostname.',
    }),
    checklistCheck(record.checklist.websocketForwarding, {
      code: 'manual_websockets',
      label: 'WebSocket forwarding',
      message: 'WebSocket forwarding is marked configured.',
      nextStep: 'Ensure the external proxy forwards WebSocket upgrades.',
    }),
  ];

  if (trustedProxyMode) {
    checks.push(checklistCheck(record.checklist.directOriginProtected, {
      code: 'manual_direct_origin',
      label: 'Direct-origin bypass',
      message: 'Direct-origin bypass protection is marked configured.',
      nextStep: 'Restrict direct browser access to Docker Host so requests must pass through the trusted proxy.',
    }));
  }

  const status = drift.length > 0
    ? 'drifted'
    : checks.some(candidate => candidate.status === 'fail')
      ? 'failed'
      : 'validated';

  return {
    checkedAt,
    status,
    checks,
    drift,
  };
}

function createSnapshot(
  exposure: Pick<GatewayExposureRecord, 'moduleId' | 'hostname' | 'portKey' | 'exposurePolicy' | 'identityMode'>,
  trustedProxyMode: boolean,
  config: HostRuntimeConfig
): ExternalIngressSnapshot {
  return {
    moduleId: exposure.moduleId,
    hostname: exposure.hostname,
    portKey: exposure.portKey,
    exposurePolicy: exposure.exposurePolicy,
    identityMode: exposure.identityMode,
    gatewayBaseDomain: config.gatewayBaseDomain,
    hostPublicOrigin: config.hostPublicOrigin,
    trustedProxyMode,
  };
}

async function hasTrustedProxyMode(config: HostRuntimeConfig) {
  const state = await readAuthStateSnapshot(config);
  if ((state.trustedProxyProviders || []).some(provider => provider.enabled)) {
    return true;
  }

  const enabled = process.env.HOST_TRUSTED_PROXY_ENABLED?.trim().toLowerCase();
  if (enabled === 'false') {
    return false;
  }

  return Boolean(
    process.env.HOST_TRUSTED_PROXY_CLOUDFLARE_TEAM_DOMAIN?.trim() ||
    process.env.HOST_TRUSTED_PROXY_ISSUER?.trim() ||
    process.env.HOST_TRUSTED_PROXY_JWKS?.trim() ||
    process.env.HOST_TRUSTED_PROXY_JWKS_URI?.trim()
  );
}

function getDrift(previous: ExternalIngressSnapshot, current: ExternalIngressSnapshot) {
  const drift: string[] = [];
  const fields: Array<keyof ExternalIngressSnapshot> = [
    'moduleId',
    'hostname',
    'portKey',
    'exposurePolicy',
    'identityMode',
    'gatewayBaseDomain',
    'hostPublicOrigin',
    'trustedProxyMode',
  ];

  for (const field of fields) {
    if (previous[field] !== current[field]) {
      drift.push(field);
    }
  }

  return drift;
}

function normalizeChecklist(checklist: ExternalIngressChecklist | undefined): ExternalIngressChecklist {
  if (!checklist) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(checklist).filter(([, value]) => typeof value === 'boolean')
  ) as ExternalIngressChecklist;
}

function check(
  passed: boolean,
  input: {
    code: string;
    label: string;
    pass: string;
    fail: string;
    nextStep?: string;
  }
): ExternalIngressValidationCheck {
  return {
    code: input.code,
    label: input.label,
    status: passed ? 'pass' : 'fail',
    message: passed ? input.pass : input.fail,
    ...(passed ? {} : { nextStep: input.nextStep }),
  };
}

function checklistCheck(
  value: boolean | undefined,
  input: {
    code: string;
    label: string;
    message: string;
    nextStep: string;
  }
): ExternalIngressValidationCheck {
  return {
    code: input.code,
    label: input.label,
    status: value ? 'pass' : 'fail',
    message: value ? input.message : 'Manual setup item is not marked complete.',
    ...(value ? {} : { nextStep: input.nextStep }),
  };
}

function isHttpsOrLoopback(origin: string | null) {
  if (!origin) {
    return false;
  }

  try {
    const url = new URL(origin);
    return url.protocol === 'https:' ||
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '::1' ||
      url.hostname.endsWith('.localhost');
  } catch {
    return false;
  }
}

function getNextStep(
  status: ExternalIngressStatus,
  record: ExternalIngressRecord | null,
  config: HostRuntimeConfig
) {
  if (!record || status === 'unmanaged') {
    return 'Create a manual ingress intent before publishing this gateway exposure externally.';
  }

  if (!config.gatewayBaseDomain || !config.hostPublicOrigin) {
    return 'Set HOST_GATEWAY_BASE_DOMAIN and HOST_PUBLIC_ORIGIN, then refresh readiness.';
  }

  if (status === 'planned') {
    return 'Complete the manual DNS, reverse proxy, TLS, and auth checklist, then mark the exposure ready.';
  }

  if (status === 'manualReady') {
    return 'Refresh validation to confirm the saved manual setup still matches Host configuration.';
  }

  if (status === 'drifted') {
    return 'Review changed Host or gateway settings, then update the external setup or unlink the ingress record.';
  }

  if (status === 'failed') {
    return 'Resolve failed readiness checks, then refresh validation.';
  }

  return 'No action required.';
}

function normalizeHostname(hostname: string) {
  return hostname.trim().toLowerCase().replace(/\.$/, '');
}
