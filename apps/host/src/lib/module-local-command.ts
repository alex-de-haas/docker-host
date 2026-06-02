import { spawn } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getHostRuntimeConfig } from './host-runtime.ts';
import { ensureAppSourcePath } from './app-source.ts';
import {
  readModulesStore,
  writeModulesStore,
} from './module-store.ts';
import {
  buildModuleServiceEnvironment,
  createModuleServiceToken,
} from './module-directory-service.ts';
import {
  getModuleContainersInStartOrder,
  getModuleContainersInStopOrder,
} from './module-lifecycle.ts';
import type { HostRuntimeConfig } from './host-runtime.ts';
import type {
  InstalledModulePortBinding,
  InstalledModuleContainerRecord,
  InstalledModuleProcessRecord,
  InstalledModuleRecord,
  InstalledSettingValue,
  ModuleRuntimeState,
  ModuleRuntimeStatus,
  NormalizedModuleContainerMetadata,
  NormalizedModuleMetadata,
  ResolvedDependency,
} from '@/types/modules';

export function getModuleProcessName(moduleId: string, processKey = 'main') {
  const normalized = moduleId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');

  return `proc-${normalized || 'app'}-${processKey}`;
}

export function isLocalCommandModule(module: Pick<InstalledModuleRecord, 'runtimeKind' | 'processes'>) {
  return module.runtimeKind === 'localCommand' || (module.processes?.length ?? 0) > 0;
}

export async function getLocalCommandRuntimeStatuses(
  module: InstalledModuleRecord
): Promise<ModuleRuntimeStatus[]> {
  return Promise.all((module.processes ?? []).map(getProcessRuntimeStatus));
}

export async function startLocalCommandProcesses(
  module: InstalledModuleRecord,
  metadata: NormalizedModuleMetadata | null,
  config: HostRuntimeConfig = getHostRuntimeConfig()
): Promise<ModuleRuntimeStatus[]> {
  const processServices = getProcessServices(metadata);
  if (processServices.length === 0) {
    return getLocalCommandRuntimeStatuses(module);
  }

  const sourcePath = await ensureAppSourcePath(module, config);
  await ensureLocalCommandDirectories(module, config);
  const serviceToken = await createModuleServiceToken({
    moduleId: module.id,
    label: 'Local command directory API token',
  }, undefined, config);

  let currentModule = module;
  const orderedServices = getModuleContainersInStartOrder(
    { containers: processServices.map(serviceToContainerDependencyRecord) },
    { containers: processServices }
  );
  for (const ordered of orderedServices) {
    const service = processServices.find(candidate => candidate.key === ordered.key);
    if (!service) {
      continue;
    }
    const existingRecord = currentModule.processes?.find(process => process.key === service.key);
    if (existingRecord?.pid && isProcessRunning(existingRecord.pid)) {
      continue;
    }

    const nextRecord = await spawnProcess({
      module: currentModule,
      service,
      sourcePath,
      serviceToken: serviceToken.token,
      config,
    });
    currentModule = await updateInstalledProcessRecord(module.id, nextRecord, config);
  }

  return getLocalCommandRuntimeStatuses(currentModule);
}

export async function stopLocalCommandProcesses(
  module: InstalledModuleRecord,
  metadata: NormalizedModuleMetadata | null,
  config: HostRuntimeConfig = getHostRuntimeConfig()
): Promise<ModuleRuntimeStatus[]> {
  const processServices = getProcessServices(metadata);
  const orderedServices = getModuleContainersInStopOrder(
    { containers: processServices.map(serviceToContainerDependencyRecord) },
    { containers: processServices }
  );
  let currentModule = module;

  for (const ordered of orderedServices) {
    const process = currentModule.processes?.find(candidate => candidate.key === ordered.key);
    if (!process?.pid) {
      continue;
    }

    await stopProcess(process.pid);
    currentModule = await updateInstalledProcessRecord(module.id, {
      ...process,
      pid: null,
      stoppedAt: new Date().toISOString(),
    }, config);
  }

  return getLocalCommandRuntimeStatuses(currentModule);
}

export async function restartLocalCommandProcesses(
  module: InstalledModuleRecord,
  metadata: NormalizedModuleMetadata | null,
  config: HostRuntimeConfig = getHostRuntimeConfig()
): Promise<ModuleRuntimeStatus[]> {
  const stoppedStoreStatuses = await stopLocalCommandProcesses(module, metadata, config);
  const store = await readModulesStore(config);
  const stoppedModule = store.modules.find(candidate => candidate.id === module.id) ?? module;
  if (stoppedStoreStatuses.some(status => status.error)) {
    return stoppedStoreStatuses;
  }
  return startLocalCommandProcesses(stoppedModule, metadata, config);
}

export function buildInstalledProcessRecords(
  moduleId: string,
  metadata: NormalizedModuleMetadata,
  portsByService: Map<string, InstalledModulePortBinding[]>,
  config: HostRuntimeConfig = getHostRuntimeConfig()
): InstalledModuleProcessRecord[] {
  return metadata.containers
    .filter(service => service.source.type === 'process')
    .map(service => ({
      key: service.key,
      processName: getModuleProcessName(moduleId, service.key),
      command: service.source.command ?? '',
      workingDirectory: service.source.workingDirectory ?? '.',
      pid: null,
      startedAt: null,
      stoppedAt: null,
      logPath: path.join(config.dataRootContainer, 'apps', moduleId, 'logs', `${service.key}.log`),
      ports: portsByService.get(service.key) ?? [],
    }));
}

async function spawnProcess(input: {
  module: InstalledModuleRecord;
  service: NormalizedModuleContainerMetadata;
  sourcePath: string;
  serviceToken: string;
  config: HostRuntimeConfig;
}): Promise<InstalledModuleProcessRecord> {
  const current = input.module.processes?.find(process => process.key === input.service.key);
  const workingDirectory = resolveWorkingDirectory(sourcePathForService(input.sourcePath, input.service), input.service);
  await fs.access(workingDirectory, fs.constants.R_OK);

  const logPath = current?.logPath ?? path.join(input.config.dataRootContainer, 'apps', input.module.id, 'logs', `${input.service.key}.log`);
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  const log = fsSync.createWriteStream(logPath, { flags: 'a' });
  const env = buildProcessEnvironment(input.module, input.service, input.serviceToken, input.config);
  const child = spawn(input.service.source.command ?? '', {
    cwd: workingDirectory,
    shell: true,
    detached: true,
    env: {
      ...process.env,
      ...input.service.source.environment,
      ...env,
    },
    stdio: ['ignore', log, log],
  });
  child.unref();
  log.end();

  if (!child.pid) {
    throw new Error(`Local command service "${input.service.key}" did not publish a process id.`);
  }

  return {
    key: input.service.key,
    processName: getModuleProcessName(input.module.id, input.service.key),
    command: input.service.source.command ?? '',
    workingDirectory,
    pid: child.pid,
    startedAt: new Date().toISOString(),
    stoppedAt: null,
    logPath,
    ports: current?.ports ?? [],
  };
}

function buildProcessEnvironment(
  module: InstalledModuleRecord,
  service: NormalizedModuleContainerMetadata,
  serviceToken: string,
  config: HostRuntimeConfig
) {
  const env: Record<string, string> = buildModuleServiceEnvironment({
    moduleId: module.id,
    serviceToken,
    hostInternalOrigin: config.hostInternalOrigin,
  });
  const firstPort = module.processes
    ?.find(process => process.key === service.key)
    ?.ports
    ?.find(port => port.hostPublished);
  if (firstPort) {
    env.PORT = String(firstPort.hostPort);
    env.HOSTY_APP_PORT = String(firstPort.hostPort);
  }

  const appDataDirectory = resolveProcessAppDataDirectory(module, service.key);
  if (appDataDirectory) {
    env.HOSTY_APP_DATA_DIR = appDataDirectory;
  }

  for (const setting of moduleSettings(module)) {
    const value = module.settings?.[setting.key];
    if (value !== undefined) {
      env[setting.key] = stringifySettingValue(value);
    }
  }

  for (const dependency of getResolvedDependencies(module)) {
    if (!dependency.resolvedBaseUrl) {
      continue;
    }
    for (const target of (dependency.targets ?? []).filter(target => target.container === service.key)) {
      env[target.name] = dependency.resolvedBaseUrl;
    }
  }

  return env;
}

function moduleSettings(module: InstalledModuleRecord): Array<{ key: string }> {
  return Object.keys(module.settings ?? {}).map(key => ({ key }));
}

function resolveProcessAppDataDirectory(module: InstalledModuleRecord, serviceKey: string) {
  const mappings = module.storageMappings || module.storage?.directories || [];
  const entries = Array.isArray(mappings) ? mappings : Object.values(mappings);
  return entries.find(mapping => mapping.container === serviceKey && mapping.key === 'data')?.hostPath ??
    entries.find(mapping => mapping.container === serviceKey && mapping.writable)?.hostPath ??
    null;
}

function getResolvedDependencies(module: InstalledModuleRecord): ResolvedDependency[] {
  const dependencies = module.resolvedDependencies || module.dependencies || [];
  return Array.isArray(dependencies) ? dependencies : Object.values(dependencies);
}

async function updateInstalledProcessRecord(
  moduleId: string,
  processRecord: InstalledModuleProcessRecord,
  config: HostRuntimeConfig
) {
  const store = await readModulesStore(config);
  let updatedModule: InstalledModuleRecord | null = null;
  await writeModulesStore({
    ...store,
    modules: store.modules.map(module => {
      if (module.id !== moduleId) {
        return module;
      }
      const processes = module.processes ?? [];
      const exists = processes.some(process => process.key === processRecord.key);
      updatedModule = {
        ...module,
        processes: exists
          ? processes.map(process => process.key === processRecord.key ? processRecord : process)
          : [...processes, processRecord],
        updatedAt: new Date().toISOString(),
      };
      return updatedModule;
    }),
  }, config);

  if (!updatedModule) {
    throw new Error(`Installed app "${moduleId}" was not found while updating local command process state.`);
  }

  return updatedModule;
}

async function ensureLocalCommandDirectories(module: InstalledModuleRecord, config: HostRuntimeConfig) {
  await fs.mkdir(path.join(config.dataRootContainer, 'apps', module.id, 'logs'), { recursive: true });
  const mappings = module.storageMappings || module.storage?.directories || [];
  const entries = Array.isArray(mappings) ? mappings : Object.values(mappings);
  await Promise.all(entries.map(mapping => fs.mkdir(mapping.hostPath, { recursive: true })));
}

async function getProcessRuntimeStatus(
  processRecord: InstalledModuleProcessRecord
): Promise<ModuleRuntimeStatus> {
  const pid = processRecord.pid ?? null;
  if (!pid) {
    return {
      state: 'not_created',
      containerId: null,
      containerName: processRecord.processName,
      startedAt: processRecord.startedAt ?? null,
      finishedAt: processRecord.stoppedAt ?? null,
    };
  }

  return {
    state: isProcessRunning(pid) ? 'running' : 'exited',
    containerId: String(pid),
    containerName: processRecord.processName,
    startedAt: processRecord.startedAt ?? null,
    finishedAt: processRecord.stoppedAt ?? null,
  };
}

async function stopProcess(pid: number) {
  if (!isProcessRunning(pid)) {
    return;
  }

  process.kill(pid, 'SIGTERM');
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 100));
    if (!isProcessRunning(pid)) {
      return;
    }
  }

  if (isProcessRunning(pid)) {
    process.kill(pid, 'SIGKILL');
  }
}

function isProcessRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getProcessServices(metadata: NormalizedModuleMetadata | null): NormalizedModuleContainerMetadata[] {
  return (metadata?.containers ?? []).filter(service => service.source.type === 'process');
}

function serviceToContainerDependencyRecord(service: NormalizedModuleContainerMetadata): InstalledModuleContainerRecord {
  return {
    key: service.key,
    containerName: getModuleProcessName('local', service.key),
    networkAlias: '',
    image: {
      ...service.image,
      reference: `${service.image.repository}:${service.image.tag}`,
    },
  };
}

function sourcePathForService(sourcePath: string, service: NormalizedModuleContainerMetadata) {
  return service.source.workingDirectory && path.isAbsolute(service.source.workingDirectory)
    ? service.source.workingDirectory
    : sourcePath;
}

function resolveWorkingDirectory(sourcePath: string, service: NormalizedModuleContainerMetadata) {
  const workingDirectory = service.source.workingDirectory ?? '.';
  return path.isAbsolute(workingDirectory)
    ? workingDirectory
    : path.resolve(sourcePath, workingDirectory);
}

function stringifySettingValue(value: InstalledSettingValue) {
  return typeof value === 'string' ? value : String(value);
}
