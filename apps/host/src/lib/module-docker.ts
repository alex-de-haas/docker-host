import Docker from 'dockerode';
import docker, { dockerConnectionDescription, formatDockerError } from '@/lib/docker';
import { getHostRuntimeConfig } from '@/lib/host-runtime';
import type { HostRuntimeConfig } from '@/lib/host-runtime';
import type {
  InstalledModuleRecord,
  ModuleOperationError,
  ModuleRuntimeState,
  ModuleRuntimeStatus,
} from '@/types/modules';

export interface DockerDaemonStatus {
  connected: boolean;
  endpoint: string;
  serverVersion: string | null;
  osType: string | null;
  error: string | null;
}

export interface ModuleNetworkStatus {
  name: string;
  ready: boolean;
  id: string | null;
  created: boolean;
  error: string | null;
}

type DockerError = Error & {
  statusCode?: number;
  json?: {
    message?: string;
  };
  reason?: string;
};

export function getModuleContainerName(module: InstalledModuleRecord) {
  return module.containerName || getModuleDockerName(module.id);
}

export function getModuleNetworkAlias(moduleId: string) {
  return getModuleDockerName(moduleId);
}

export function getModuleDockerName(moduleId: string) {
  const normalized = moduleId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');

  return `mod-${normalized || 'module'}`;
}

export async function getDockerDaemonStatus(): Promise<DockerDaemonStatus> {
  try {
    await docker.ping();
    const version = await docker.version();

    return {
      connected: true,
      endpoint: dockerConnectionDescription,
      serverVersion: String(version.Version ?? ''),
      osType: getDockerVersionOsType(version),
      error: null,
    };
  } catch (error) {
    return {
      connected: false,
      endpoint: dockerConnectionDescription,
      serverVersion: null,
      osType: null,
      error: formatDockerError(error),
    };
  }
}

export async function ensureModuleNetwork(
  config: HostRuntimeConfig = getHostRuntimeConfig()
): Promise<ModuleNetworkStatus> {
  try {
    const existing = await inspectNetwork(config.moduleNetwork);
    if (existing) {
      return {
        name: config.moduleNetwork,
        ready: true,
        id: existing.Id ?? null,
        created: false,
        error: null,
      };
    }

    const created = await docker.createNetwork({
      Name: config.moduleNetwork,
      Driver: 'bridge',
      CheckDuplicate: true,
    });
    const createdInfo = await created.inspect();

    return {
      name: config.moduleNetwork,
      ready: true,
      id: createdInfo.Id ?? created.id ?? null,
      created: true,
      error: null,
    };
  } catch (error) {
    return {
      name: config.moduleNetwork,
      ready: false,
      id: null,
      created: false,
      error: formatDockerError(error),
    };
  }
}

export async function getModuleRuntimeStatus(
  module: InstalledModuleRecord
): Promise<ModuleRuntimeStatus> {
  const containerName = getModuleContainerName(module);

  try {
    const info = await docker.getContainer(containerName).inspect();
    return mapContainerRuntimeStatus(info, containerName);
  } catch (error) {
    if (getDockerStatusCode(error) === 404) {
      return {
        state: 'not_created',
        containerId: null,
        containerName,
        startedAt: null,
        finishedAt: null,
      };
    }

    return {
      state: 'unknown',
      containerId: null,
      containerName,
      startedAt: null,
      finishedAt: null,
      error: formatDockerError(error),
    };
  }
}

export async function startModuleContainer(module: InstalledModuleRecord) {
  await ensureModuleContainerNetwork(module);
  const container = docker.getContainer(getModuleContainerName(module));
  await container.start();
  return getModuleRuntimeStatus(module);
}

export async function stopModuleContainer(module: InstalledModuleRecord) {
  const container = docker.getContainer(getModuleContainerName(module));
  await container.stop();
  return getModuleRuntimeStatus(module);
}

export async function restartModuleContainer(module: InstalledModuleRecord) {
  await ensureModuleContainerNetwork(module);
  const container = docker.getContainer(getModuleContainerName(module));
  await container.restart();
  return getModuleRuntimeStatus(module);
}

export function toModuleOperationError(
  operation: string,
  error: unknown,
  fallbackMessage: string,
  nextStep: string
): ModuleOperationError {
  return {
    operation,
    httpStatus: 500,
    dockerStatusCode: getDockerStatusCode(error),
    dockerMessage: getDockerMessage(error),
    message: fallbackMessage,
    nextStep,
    occurredAt: new Date().toISOString(),
  };
}

async function ensureModuleContainerNetwork(module: InstalledModuleRecord) {
  const network = await ensureModuleNetwork();
  if (!network.ready) {
    throw new Error(network.error || `Docker network "${network.name}" is unavailable.`);
  }

  const containerName = getModuleContainerName(module);
  const info = await docker.getContainer(containerName).inspect();

  if (info.NetworkSettings.Networks?.[network.name]) {
    return;
  }

  await docker.getNetwork(network.name).connect({
    Container: info.Id,
    EndpointConfig: {
      Aliases: [getModuleNetworkAlias(module.id)],
    },
  });
}

async function inspectNetwork(name: string): Promise<Docker.NetworkInspectInfo | null> {
  try {
    return await docker.getNetwork(name).inspect();
  } catch (error) {
    if (getDockerStatusCode(error) === 404) {
      return null;
    }

    throw error;
  }
}

function mapContainerRuntimeStatus(
  info: Docker.ContainerInspectInfo,
  containerName: string
): ModuleRuntimeStatus {
  return {
    state: mapDockerState(info.State.Status),
    containerId: info.Id,
    containerName,
    startedAt: isMeaningfulDockerTimestamp(info.State.StartedAt) ? info.State.StartedAt : null,
    finishedAt: isMeaningfulDockerTimestamp(info.State.FinishedAt) ? info.State.FinishedAt : null,
  };
}

function mapDockerState(state?: string): ModuleRuntimeState {
  switch (state?.toLowerCase()) {
    case 'created':
      return 'created';
    case 'running':
      return 'running';
    case 'paused':
      return 'paused';
    case 'restarting':
      return 'restarting';
    case 'exited':
      return 'exited';
    case 'dead':
      return 'dead';
    default:
      return 'unknown';
  }
}

function getDockerVersionOsType(version: Docker.DockerVersion) {
  const fields = version as Docker.DockerVersion & { OSType?: string };
  return String(fields.Os ?? fields.OSType ?? '');
}

function isMeaningfulDockerTimestamp(value?: string) {
  return Boolean(value && !value.startsWith('0001-01-01'));
}

function getDockerStatusCode(error: unknown) {
  return isDockerError(error) && typeof error.statusCode === 'number' ? error.statusCode : undefined;
}

function getDockerMessage(error: unknown) {
  if (isDockerError(error)) {
    return error.json?.message || error.reason || error.message;
  }

  return error instanceof Error ? error.message : undefined;
}

function isDockerError(error: unknown): error is DockerError {
  return error instanceof Error;
}
