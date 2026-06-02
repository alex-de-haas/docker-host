import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getHostRuntimeConfig, pathExists } from './host-runtime.ts';
import { readAppsStore, writeAppsStore } from './app-store.ts';
import type { HostRuntimeConfig } from './host-runtime.ts';
import type { InstalledAppRecord } from './app-store.ts';
import type { InstalledAppSourceState } from '@/types/modules';

export function getSourcesRootContainer(config: HostRuntimeConfig = getHostRuntimeConfig()) {
  return config.sourcesRootContainer ?? path.join(config.dataRootContainer, 'sources');
}

export function getDefaultManagedSourcePath(appId: string, config: HostRuntimeConfig = getHostRuntimeConfig()) {
  return path.join(getSourcesRootContainer(config), appId);
}

export function extractAppManifestSourceState(
  rawBytes: Buffer,
  appId: string,
  config: HostRuntimeConfig = getHostRuntimeConfig()
): InstalledAppSourceState | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBytes.toString('utf-8')) as unknown;
  } catch {
    return undefined;
  }

  if (!isObject(parsed) || parsed.schemaVersion !== 'app.0.1' || !isObject(parsed.source)) {
    return undefined;
  }

  const type = readString(parsed.source, 'type');
  const repository = readString(parsed.source, 'repository');
  if (type !== 'git' || !repository) {
    return undefined;
  }

  const ref = readString(parsed.source, 'ref');
  const commit = readString(parsed.source, 'commit');
  return {
    mode: 'managedCheckout',
    repository,
    ...(ref ? { ref } : {}),
    ...(commit ? { commit } : {}),
    path: path.relative(config.dataRootContainer, getDefaultManagedSourcePath(appId, config)),
    updatedAt: new Date().toISOString(),
  };
}

export function resolveAppSourcePath(
  app: Pick<InstalledAppRecord, 'id' | 'sourceState'>,
  config: HostRuntimeConfig = getHostRuntimeConfig()
) {
  const state = app.sourceState;
  if (state?.mode === 'localOverride' && state.localPath) {
    return state.localPath;
  }

  if (state?.path) {
    return path.isAbsolute(state.path)
      ? state.path
      : path.join(config.dataRootContainer, state.path);
  }

  return getDefaultManagedSourcePath(app.id, config);
}

export async function updateAppLocalSourceOverride(
  appId: string,
  localPath: string,
  config: HostRuntimeConfig = getHostRuntimeConfig()
) {
  const store = await readAppsStore(config);
  const app = store.apps.find(candidate => candidate.id === appId);
  if (!app) {
    throw new AppSourceError('app_not_found', `App "${appId}" is not installed.`, 404);
  }

  const resolvedPath = path.resolve(localPath);
  const stat = await fs.stat(resolvedPath).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new AppSourceError('source_path_invalid', `Local source path "${resolvedPath}" is not a directory.`, 422);
  }

  const nextState: InstalledAppSourceState = {
    ...(app.sourceState ?? { mode: 'localOverride' }),
    mode: 'localOverride',
    localPath: resolvedPath,
    updatedAt: new Date().toISOString(),
  };

  await writeAppsStore({
    ...store,
    apps: store.apps.map(candidate =>
      candidate.id === appId
        ? { ...candidate, sourceState: nextState }
        : candidate
    ),
  }, config);

  return nextState;
}

export async function ensureAppSourcePath(
  app: Pick<InstalledAppRecord, 'id' | 'sourceState'>,
  config: HostRuntimeConfig = getHostRuntimeConfig()
) {
  const sourcePath = resolveAppSourcePath(app, config);
  if (app.sourceState?.mode === 'localOverride') {
    if (!(await pathExists(sourcePath))) {
      throw new AppSourceError(
        'source_path_missing',
        `Local source override path "${sourcePath}" does not exist.`,
        409
      );
    }
    return sourcePath;
  }

  const state = app.sourceState;
  if (!state?.repository) {
    if (await pathExists(sourcePath)) {
      return sourcePath;
    }
    throw new AppSourceError(
      'source_repository_missing',
      `App "${app.id}" does not have source repository state or a local source override.`,
      409
    );
  }

  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  if (!(await pathExists(sourcePath))) {
    await runGit([
      'clone',
      ...(state.ref ? ['--branch', state.ref, '--single-branch'] : []),
      state.repository,
      sourcePath,
    ], config.dataRootContainer);
  } else {
    await runGit(['-C', sourcePath, 'fetch', '--all', '--tags'], config.dataRootContainer);
  }

  if (state.commit) {
    await runGit(['-C', sourcePath, 'checkout', state.commit], config.dataRootContainer);
  } else if (state.ref) {
    await runGit(['-C', sourcePath, 'checkout', state.ref], config.dataRootContainer);
  }

  return sourcePath;
}

export class AppSourceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'AppSourceError';
  }
}

function runGit(args: string[], cwd: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stderr: Buffer[] = [];
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`git ${args.join(' ')} failed: ${Buffer.concat(stderr).toString('utf-8').trim()}`));
    });
  });
}

function readString(source: Record<string, unknown>, key: string) {
  const value = source[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
