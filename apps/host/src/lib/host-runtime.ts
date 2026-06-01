import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_DATA_ROOT = path.join(os.homedir(), '.docker-host');
const DEFAULT_DOCKER_SOCKET = '/var/run/docker.sock';
const DEFAULT_MODULE_NETWORK = 'docker-host-modules';
const DEFAULT_HOST_INTERNAL_ORIGIN = 'http://docker-host:3000';
const DEFAULT_MODULE_HOST_PORT_START = 3100;
const DEFAULT_MODULE_HOST_PORT_END = 3999;
const DATA_ROOT_MARKER_FILE = '.docker-host-root.json';

export interface HostRuntimeConfig {
  dataRootHost: string;
  dataRootContainer: string;
  dataRootMarkerPath: string;
  dataRootExpectedMarker: string | null;
  modulesRootContainer: string;
  modulesStorePath: string;
  moduleDevModeEnabled?: boolean;
  moduleDevRootContainer?: string;
  moduleDevTargetsPath?: string;
  authRootContainer: string;
  authStatePath: string;
  authAuditPath: string;
  gatewayRootContainer: string;
  gatewayExposuresPath: string;
  ingressRootContainer?: string;
  ingressStatePath?: string;
  gatewayBaseDomain: string | null;
  hostPublicOrigin: string | null;
  hostBindAddress?: string | null;
  hostInternalOrigin: string;
  dockerSocketPath: string;
  moduleNetwork: string;
  moduleHostPortRange?: {
    start: number;
    end: number;
  };
}

export interface HostDataRootStatus {
  hostPath: string;
  containerPath: string;
  modulesPath: string;
  modulesStorePath: string;
  ready: boolean;
  writable: boolean;
  error: string | null;
}

export class HostDataRootUnavailableError extends Error {
  readonly code = 'data_root_unavailable';
  readonly markerPath: string;

  constructor(
    message: string,
    markerPath: string
  ) {
    super(message);
    this.name = 'HostDataRootUnavailableError';
    this.markerPath = markerPath;
  }
}

export function getHostRuntimeConfig(): HostRuntimeConfig {
  const configuredDataRootHost = process.env.HOST_DATA_ROOT_HOST?.trim();
  const configuredDataRootContainer = process.env.HOST_DATA_ROOT_CONTAINER?.trim();
  const dataRootContainer =
    configuredDataRootContainer || configuredDataRootHost || DEFAULT_DATA_ROOT;
  const dataRootHost = configuredDataRootHost || dataRootContainer;

  const dockerSocketPath =
    process.env.HOST_DOCKER_SOCKET?.trim() ||
    process.env.DOCKER_SOCKET_PATH?.trim() ||
    DEFAULT_DOCKER_SOCKET;

  const moduleNetwork = process.env.HOST_MODULE_NETWORK?.trim() || DEFAULT_MODULE_NETWORK;
  const modulesRootContainer = path.join(dataRootContainer, 'modules');
  const moduleDevRootContainer = path.join(dataRootContainer, 'dev');
  const authRootContainer = path.join(dataRootContainer, 'auth');
  const gatewayRootContainer = path.join(dataRootContainer, 'gateway');
  const ingressRootContainer = path.join(dataRootContainer, 'ingress');

  return {
    dataRootHost,
    dataRootContainer,
    dataRootMarkerPath: path.join(dataRootContainer, DATA_ROOT_MARKER_FILE),
    dataRootExpectedMarker: normalizeOptionalRuntimeValue(process.env.HOST_DATA_ROOT_MARKER),
    modulesRootContainer,
    modulesStorePath: path.join(dataRootContainer, 'modules.json'),
    moduleDevModeEnabled: isEnabledRuntimeFlag(process.env.HOST_MODULE_DEV_MODE),
    moduleDevRootContainer,
    moduleDevTargetsPath: path.join(moduleDevRootContainer, 'module-targets.json'),
    authRootContainer,
    authStatePath: path.join(authRootContainer, 'state.json'),
    authAuditPath: path.join(authRootContainer, 'audit.ndjson'),
    gatewayRootContainer,
    gatewayExposuresPath: path.join(gatewayRootContainer, 'exposures.json'),
    ingressRootContainer,
    ingressStatePath: path.join(ingressRootContainer, 'external-ingress.json'),
    gatewayBaseDomain: normalizeOptionalRuntimeValue(process.env.HOST_GATEWAY_BASE_DOMAIN),
    hostPublicOrigin: normalizeOptionalRuntimeValue(process.env.HOST_PUBLIC_ORIGIN),
    hostBindAddress: normalizeOptionalRuntimeValue(process.env.HOST_BIND_ADDRESS),
    hostInternalOrigin: normalizeOptionalRuntimeValue(process.env.HOST_INTERNAL_ORIGIN) ?? DEFAULT_HOST_INTERNAL_ORIGIN,
    dockerSocketPath,
    moduleNetwork,
    moduleHostPortRange: parseModuleHostPortRange(process.env.HOST_MODULE_PORT_RANGE),
  };
}

export async function ensureHostDataRoot(config = getHostRuntimeConfig()): Promise<HostDataRootStatus> {
  const moduleDevRootContainer = config.moduleDevRootContainer ?? path.join(config.dataRootContainer, 'dev');
  const ingressRootContainer = config.ingressRootContainer ?? path.join(config.dataRootContainer, 'ingress');
  try {
    await verifyHostDataRootMarker(config);
    await fs.mkdir(config.dataRootContainer, { recursive: true });
    await fs.mkdir(config.modulesRootContainer, { recursive: true });
    if (config.moduleDevModeEnabled) {
      await fs.mkdir(moduleDevRootContainer, { recursive: true });
    }
    await fs.mkdir(config.authRootContainer, { recursive: true });
    await fs.mkdir(config.gatewayRootContainer, { recursive: true });
    await fs.mkdir(ingressRootContainer, { recursive: true });
    await fs.access(config.dataRootContainer, fs.constants.R_OK | fs.constants.W_OK);
    await fs.access(config.modulesRootContainer, fs.constants.R_OK | fs.constants.W_OK);
    if (config.moduleDevModeEnabled) {
      await fs.access(moduleDevRootContainer, fs.constants.R_OK | fs.constants.W_OK);
    }
    await fs.access(config.authRootContainer, fs.constants.R_OK | fs.constants.W_OK);
    await fs.access(config.gatewayRootContainer, fs.constants.R_OK | fs.constants.W_OK);
    await fs.access(ingressRootContainer, fs.constants.R_OK | fs.constants.W_OK);

    return {
      hostPath: config.dataRootHost,
      containerPath: config.dataRootContainer,
      modulesPath: config.modulesRootContainer,
      modulesStorePath: config.modulesStorePath,
      ready: true,
      writable: true,
      error: null,
    };
  } catch (error) {
    return {
      hostPath: config.dataRootHost,
      containerPath: config.dataRootContainer,
      modulesPath: config.modulesRootContainer,
      modulesStorePath: config.modulesStorePath,
      ready: false,
      writable: false,
      error: error instanceof Error ? error.message : 'Unknown data root error',
    };
  }
}

export async function verifyHostDataRootMarker(config = getHostRuntimeConfig()) {
  const expectedMarker = config.dataRootExpectedMarker?.trim();
  if (!expectedMarker) {
    return;
  }

  const markerPath = config.dataRootMarkerPath || path.join(config.dataRootContainer, DATA_ROOT_MARKER_FILE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(markerPath, 'utf-8')) as unknown;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new HostDataRootUnavailableError(
        `Host data root marker is missing at ${markerPath}. The configured data root may not be mounted.`,
        markerPath
      );
    }
    throw error;
  }

  const actualMarker = isObject(parsed) && typeof parsed.id === 'string' ? parsed.id.trim() : '';
  if (actualMarker !== expectedMarker) {
    throw new HostDataRootUnavailableError(
      `Host data root marker at ${markerPath} does not match the running container configuration.`,
      markerPath
    );
  }
}

export function isHostDataRootUnavailableError(error: unknown): error is HostDataRootUnavailableError {
  return error instanceof HostDataRootUnavailableError ||
    (
      error instanceof Error &&
      'code' in error &&
      error.code === 'data_root_unavailable'
    );
}

export async function syncPathOwnershipWithDataRoot(
  targetPath: string,
  config = getHostRuntimeConfig()
) {
  try {
    const [dataRootStat, targetStat] = await Promise.all([
      fs.stat(config.dataRootContainer),
      fs.stat(targetPath),
    ]);

    if (targetStat.uid === dataRootStat.uid && targetStat.gid === dataRootStat.gid) {
      return;
    }

    await fs.chown(targetPath, dataRootStat.uid, dataRootStat.gid);
  } catch (error) {
    if (error instanceof Error && 'code' in error) {
      const code = error.code;
      if (
        code === 'ENOENT' ||
        code === 'EACCES' ||
        code === 'EPERM' ||
        code === 'EINVAL' ||
        code === 'ENOSYS' ||
        code === 'ENOTSUP' ||
        code === 'EOPNOTSUPP'
      ) {
        return;
      }
    }

    throw error;
  }
}

export async function pathExists(targetPath: string) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function normalizeOptionalRuntimeValue(value: string | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function isEnabledRuntimeFlag(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  return normalized === '1' ||
    normalized === 'true' ||
    normalized === 'enabled' ||
    normalized === 'on' ||
    normalized === 'yes';
}

function parseModuleHostPortRange(value: string | undefined) {
  const normalized = value?.trim();
  if (!normalized) {
    return {
      start: DEFAULT_MODULE_HOST_PORT_START,
      end: DEFAULT_MODULE_HOST_PORT_END,
    };
  }

  const match = /^(\d{1,5})\s*-\s*(\d{1,5})$/.exec(normalized);
  const start = match ? Number(match[1]) : Number.NaN;
  const end = match ? Number(match[2]) : Number.NaN;

  if (
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 1 &&
    end <= 65535 &&
    start <= end
  ) {
    return { start, end };
  }

  return {
    start: DEFAULT_MODULE_HOST_PORT_START,
    end: DEFAULT_MODULE_HOST_PORT_END,
  };
}
