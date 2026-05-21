import Docker from 'dockerode';
import docker, { dockerConnectionDescription, formatDockerError } from '@/lib/docker';
import { getHostRuntimeConfig } from '@/lib/host-runtime';
import type { HostRuntimeConfig } from '@/lib/host-runtime';
import type {
  InstallPlanImage,
  InstalledModuleRecord,
  ModuleOperationError,
  ModuleRuntimeState,
  ModuleRuntimeStatus,
  ModuleRuntimePortMetadata,
  NormalizedModuleContainerMetadata,
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

export interface DockerContainerNameStatus {
  name: string;
  exists: boolean;
  id: string | null;
  image: string | null;
}

export interface ModuleNetworkInspection {
  name: string;
  exists: boolean;
  id: string | null;
  aliases: Array<{
    alias: string;
    containerId: string;
    containerName: string;
  }>;
}

export interface ModuleContainerMount {
  hostPath: string;
  containerPath: string;
  readOnly: boolean;
}

export interface CreateModuleContainerInput {
  moduleId: string;
  containerName: string;
  networkName: string;
  networkAlias: string;
  imageReference: string;
  env: Record<string, string>;
  mounts: ModuleContainerMount[];
  ports: ModuleRuntimePortMetadata[];
  resources?: NormalizedModuleContainerMetadata['runtime']['resources'];
}

type DockerError = Error & {
  statusCode?: number;
  json?: {
    message?: string;
  };
  reason?: string;
};

export function getModuleContainerName(module: InstalledModuleRecord) {
  return module.containers[0]?.containerName || getModuleDockerName(module.id, 'main');
}

export function getModuleNetworkAlias(moduleId: string, containerKey = 'main') {
  return getModuleDockerName(moduleId, containerKey);
}

export function getModuleDockerName(moduleId: string, containerKey = 'main') {
  const normalized = moduleId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');

  return `mod-${normalized || 'module'}-${containerKey}`;
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

export async function inspectContainerNameReadOnly(
  name: string
): Promise<DockerContainerNameStatus> {
  try {
    const info = await docker.getContainer(name).inspect();

    return {
      name,
      exists: true,
      id: info.Id ?? null,
      image: info.Config?.Image ?? null,
    };
  } catch (error) {
    if (getDockerStatusCode(error) === 404) {
      return {
        name,
        exists: false,
        id: null,
        image: null,
      };
    }

    throw error;
  }
}

export async function inspectModuleNetworkReadOnly(
  config: HostRuntimeConfig = getHostRuntimeConfig()
): Promise<ModuleNetworkInspection> {
  try {
    const info = await docker.getNetwork(config.moduleNetwork).inspect();
    const containers = info.Containers ?? {};

    return {
      name: config.moduleNetwork,
      exists: true,
      id: info.Id ?? null,
      aliases: Object.entries(containers).flatMap(([containerId, endpoint]) => {
        const endpointInfo = endpoint as {
          Name?: string;
          Aliases?: string[];
        };

        return (endpointInfo.Aliases ?? []).map(alias => ({
          alias,
          containerId,
          containerName: endpointInfo.Name ?? containerId,
        }));
      }),
    };
  } catch (error) {
    if (getDockerStatusCode(error) === 404) {
      return {
        name: config.moduleNetwork,
        exists: false,
        id: null,
        aliases: [],
      };
    }

    throw error;
  }
}

export async function pullModuleImage(image: InstallPlanImage) {
  if (image.pullPolicy === 'manual') {
    await ensureImageExists(
      image.reference,
      `Image "${image.reference}" is required locally because pullPolicy is manual. Pull it manually, then retry the install.`
    );
    return;
  }

  if (image.pullPolicy === 'ifNotPresent' && await imageExists(image.reference)) {
    return;
  }

  await pullImageReference(image.reference);
}

export async function createAndStartModuleContainer(config: CreateModuleContainerInput) {
  const container = await docker.createContainer(buildModuleContainerCreateOptions(config));
  await container.start();
  return getModuleRuntimeStatus({
    id: config.moduleId,
    metadataUrl: '',
    containers: [{
      key: 'main',
      containerName: config.containerName,
      networkAlias: config.networkAlias,
      image: {
        repository: config.imageReference,
        tag: 'latest',
        reference: config.imageReference,
      },
    }],
  });
}

export async function ensureModuleContainerStarted(module: InstalledModuleRecord) {
  await ensureModuleContainerNetwork(module);
  const container = docker.getContainer(getModuleContainerName(module));
  const info = await container.inspect();

  if (!info.State.Running) {
    await container.start();
  }

  return getModuleRuntimeStatus(module);
}

export async function removeModuleContainerIfExists(module: InstalledModuleRecord) {
  const containerName = getModuleContainerName(module);

  try {
    const container = docker.getContainer(containerName);
    await container.inspect();
    await container.remove({ force: true });
    return {
      removed: true,
      existed: true,
      containerName,
    };
  } catch (error) {
    if (getDockerStatusCode(error) === 404) {
      return {
        removed: false,
        existed: false,
        containerName,
      };
    }

    throw error;
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
      Aliases: [module.containers[0]?.networkAlias || getModuleNetworkAlias(module.id)],
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

function buildModuleContainerCreateOptions(
  config: CreateModuleContainerInput
): Docker.ContainerCreateOptions {
  const exposedPorts = Object.fromEntries(
    config.ports.map(port => [`${port.containerPort}/tcp`, {}])
  );
  const resources = buildResourceHostConfig(config.resources);

  return {
    name: config.containerName,
    Image: config.imageReference,
    ExposedPorts: Object.keys(exposedPorts).length > 0 ? exposedPorts : undefined,
    Env: Object.entries(config.env).map(([key, value]) => `${key}=${value}`),
    HostConfig: {
      NetworkMode: config.networkName,
      RestartPolicy: { Name: 'unless-stopped' },
      Mounts: config.mounts.map(mount => ({
        Type: 'bind',
        Source: mount.hostPath,
        Target: mount.containerPath,
        ReadOnly: mount.readOnly,
      })),
      ...resources,
    },
    NetworkingConfig: {
      EndpointsConfig: {
        [config.networkName]: {
          Aliases: [config.networkAlias],
        },
      },
    },
  };
}

function buildResourceHostConfig(
  resources: NormalizedModuleContainerMetadata['runtime']['resources'] | undefined
): Partial<Docker.HostConfig> {
  if (!resources) {
    return {};
  }

  return {
    ...(resources.cpus !== undefined ? { NanoCpus: Math.round(resources.cpus * 1_000_000_000) } : {}),
    ...(resources.memory ? { Memory: parseMemoryBytes(resources.memory) } : {}),
  };
}

function parseMemoryBytes(value: string) {
  const match = /^(\d+(?:\.\d+)?)(?:\s*(b|k|kb|m|mb|g|gb))?$/i.exec(value.trim());

  if (!match) {
    throw new Error(`runtime.resources.memory "${value}" is not a supported Docker Host memory value.`);
  }

  const amount = Number(match[1]);
  const unit = (match[2] || 'b').toLowerCase();
  const multiplier =
    unit === 'g' || unit === 'gb'
      ? 1024 * 1024 * 1024
      : unit === 'm' || unit === 'mb'
        ? 1024 * 1024
        : unit === 'k' || unit === 'kb'
          ? 1024
          : 1;

  return Math.round(amount * multiplier);
}

async function ensureImageExists(imageReference: string, missingMessage: string) {
  if (await imageExists(imageReference)) {
    return;
  }

  throw new Error(missingMessage);
}

async function imageExists(imageReference: string) {
  try {
    await docker.getImage(imageReference).inspect();
    return true;
  } catch (error) {
    if (getDockerStatusCode(error) === 404) {
      return false;
    }

    throw error;
  }
}

async function pullImageReference(imageReference: string) {
  await new Promise<void>((resolve, reject) => {
    docker.pull(imageReference, (err: Error | null, stream: NodeJS.ReadableStream) => {
      if (err) {
        reject(err);
        return;
      }

      docker.modem.followProgress(stream, (followError: Error | null) => {
        if (followError) {
          reject(followError);
        } else {
          resolve();
        }
      });
    });
  });
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
