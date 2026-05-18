import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_DATA_ROOT = path.join(os.homedir(), '.docker-host');
const DEFAULT_DOCKER_SOCKET = '/var/run/docker.sock';
const DEFAULT_MODULE_NETWORK = 'docker-host-modules';

export interface HostRuntimeConfig {
  dataRootHost: string;
  dataRootContainer: string;
  modulesRootContainer: string;
  modulesStorePath: string;
  authRootContainer: string;
  authStatePath: string;
  authAuditPath: string;
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
  const authRootContainer = path.join(dataRootContainer, 'auth');

  return {
    dataRootHost,
    dataRootContainer,
    modulesRootContainer,
    modulesStorePath: path.join(dataRootContainer, 'modules.json'),
    authRootContainer,
    authStatePath: path.join(authRootContainer, 'state.json'),
    authAuditPath: path.join(authRootContainer, 'audit.ndjson'),
    dockerSocketPath,
    moduleNetwork,
  };
}

export async function ensureHostDataRoot(config = getHostRuntimeConfig()): Promise<HostDataRootStatus> {
  try {
    await fs.mkdir(config.dataRootContainer, { recursive: true });
    await fs.mkdir(config.modulesRootContainer, { recursive: true });
    await fs.mkdir(config.authRootContainer, { recursive: true });
    await fs.access(config.dataRootContainer, fs.constants.R_OK | fs.constants.W_OK);
    await fs.access(config.modulesRootContainer, fs.constants.R_OK | fs.constants.W_OK);
    await fs.access(config.authRootContainer, fs.constants.R_OK | fs.constants.W_OK);

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
