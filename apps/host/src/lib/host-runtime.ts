import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_DATA_ROOT = path.join(os.homedir(), '.docker-host');
const DEFAULT_DOCKER_SOCKET = '/var/run/docker.sock';
const DEFAULT_MODULE_NETWORK = 'docker-host-modules';
const DEFAULT_HOST_INTERNAL_ORIGIN = 'http://docker-host:3000';

export interface HostRuntimeConfig {
  dataRootHost: string;
  dataRootContainer: string;
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
  };
}

export async function ensureHostDataRoot(config = getHostRuntimeConfig()): Promise<HostDataRootStatus> {
  const moduleDevRootContainer = config.moduleDevRootContainer ?? path.join(config.dataRootContainer, 'dev');
  const ingressRootContainer = config.ingressRootContainer ?? path.join(config.dataRootContainer, 'ingress');
  try {
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

function isEnabledRuntimeFlag(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  return normalized === '1' ||
    normalized === 'true' ||
    normalized === 'enabled' ||
    normalized === 'on' ||
    normalized === 'yes';
}
