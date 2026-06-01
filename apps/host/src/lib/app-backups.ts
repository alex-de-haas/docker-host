import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getAppsRootContainer } from '@/lib/app-store';
import { ensureHostDataRoot, getHostRuntimeConfig, pathExists } from '@/lib/host-runtime';
import { readModulesStoreSnapshot } from '@/lib/module-store';
import { getStoredStorageMappings, resolveContainerDataPath } from '@/lib/module-recovery-model';
import { stopInstalledModule } from '@/lib/module-service';
import type { HostRuntimeConfig } from '@/lib/host-runtime';

export type AppBackupReason = 'pre-update' | 'manual' | 'pre-runtime-switch' | 'pre-restore' | 'scheduled';

export interface AppDataBackupRecord {
  schemaVersion: 'app-backup.0.1';
  id: string;
  appId: string;
  reason: AppBackupReason;
  createdAt: string;
  dataPath: string;
  archivePath: string;
  archiveDigest: string;
  archiveBytes: number;
  fileCount: number;
}

export interface RestoreAppDataBackupOptions {
  stopBeforeRestore?: boolean;
  createPreRestoreBackup?: boolean;
}

export class AppBackupError extends Error {
  readonly status: 404 | 409 | 422 | 500;
  readonly code: string;

  constructor(status: AppBackupError['status'], code: string, message: string) {
    super(message);
    this.name = 'AppBackupError';
    this.status = status;
    this.code = code;
  }
}

export async function createAppDataBackup(
  appId: string,
  reason: AppBackupReason,
  config = getHostRuntimeConfig()
) {
  await ensureHostDataRoot(config);
  const dataPath = await resolveAppDataDirectory(appId, config);
  if (!dataPath || !(await pathExists(dataPath))) {
    return null;
  }

  const createdAt = new Date().toISOString();
  const backupId = `${formatBackupTimestamp(createdAt)}_${reason}_${randomUUID().slice(0, 8)}`;
  const backupRoot = getBackupRoot(appId, config);
  const archivePath = path.join(backupRoot, `${backupId}.zip`);
  const metadataPath = path.join(backupRoot, `${backupId}.json`);
  const entries = await collectZipEntries(dataPath);
  const archive = buildZipArchive(entries);
  const archiveDigest = `sha256:${createHash('sha256').update(archive).digest('hex')}`;
  const record: AppDataBackupRecord = {
    schemaVersion: 'app-backup.0.1',
    id: backupId,
    appId,
    reason,
    createdAt,
    dataPath,
    archivePath,
    archiveDigest,
    archiveBytes: archive.byteLength,
    fileCount: entries.length,
  };

  await fs.mkdir(backupRoot, { recursive: true });
  await fs.writeFile(archivePath, archive);
  await fs.writeFile(metadataPath, `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
  return record;
}

export async function listAppDataBackups(
  appId: string,
  config = getHostRuntimeConfig()
) {
  await ensureHostDataRoot(config);
  const backupRoot = getBackupRoot(appId, config);
  if (!(await pathExists(backupRoot))) {
    return [];
  }

  const names = await fs.readdir(backupRoot);
  const records = await Promise.all(
    names
      .filter(name => name.endsWith('.json'))
      .map(async name => readBackupRecord(path.join(backupRoot, name)).catch(() => null))
  );

  return records
    .filter((record): record is AppDataBackupRecord => record !== null && record.appId === appId)
    .sort((first, second) => second.createdAt.localeCompare(first.createdAt));
}

export async function restoreAppDataBackup(
  appId: string,
  backupId: string,
  options: RestoreAppDataBackupOptions = {},
  config = getHostRuntimeConfig()
) {
  await ensureHostDataRoot(config);
  const backup = await findBackupRecord(appId, backupId, config);
  if (!backup) {
    throw new AppBackupError(404, 'backup_not_found', `Backup "${backupId}" was not found for app "${appId}".`);
  }

  const dataPath = await resolveAppDataDirectory(appId, config) ?? backup.dataPath;
  const stopBeforeRestore = options.stopBeforeRestore ?? true;
  const createPreRestoreBackup = options.createPreRestoreBackup ?? true;

  if (stopBeforeRestore) {
    const stopResult = await stopInstalledModule(appId);
    if (!stopResult.success) {
      throw new AppBackupError(
        409,
        'app_stop_failed',
        stopResult.error?.message ?? `App "${appId}" could not be stopped before restore.`
      );
    }
  }

  const preRestoreBackup = createPreRestoreBackup
    ? await createAppDataBackup(appId, 'pre-restore', config)
    : null;
  const archive = await fs.readFile(backup.archivePath);
  verifyArchiveDigest(archive, backup);

  const restoreRoot = `${dataPath}.restore-${process.pid}-${Date.now()}`;
  await fs.rm(restoreRoot, { recursive: true, force: true });
  await fs.mkdir(restoreRoot, { recursive: true });
  await extractZipArchive(archive, restoreRoot);

  const replacedRoot = `${dataPath}.replaced-${process.pid}-${Date.now()}`;
  if (await pathExists(dataPath)) {
    await fs.rename(dataPath, replacedRoot);
  }

  try {
    await fs.rename(restoreRoot, dataPath);
  } catch (error) {
    if (await pathExists(replacedRoot)) {
      await fs.rename(replacedRoot, dataPath);
    }
    throw error;
  } finally {
    await fs.rm(restoreRoot, { recursive: true, force: true });
  }

  await fs.rm(replacedRoot, { recursive: true, force: true }).catch(() => undefined);

  return {
    restored: backup,
    preRestoreBackup,
  };
}

export async function resolveAppDataDirectory(
  appId: string,
  config = getHostRuntimeConfig()
) {
  assertSafeAppId(appId);
  const appDataPath = path.join(getAppsRootContainer(config), appId, 'data');
  if (await pathExists(appDataPath)) {
    return appDataPath;
  }

  const store = await readModulesStoreSnapshot(config);
  const installedModule = store.modules.find(candidate => candidate.id === appId);
  if (!installedModule) {
    return appDataPath;
  }

  const storageMappings = getStoredStorageMappings(installedModule);
  const dataMapping = storageMappings.find(mapping => mapping.key === 'data') ??
    storageMappings.find(mapping => path.basename(mapping.hostPath) === 'data');
  if (!dataMapping) {
    return appDataPath;
  }

  return resolveContainerDataPath(dataMapping.hostPath, config) ?? dataMapping.hostPath;
}

function getBackupRoot(appId: string, config: HostRuntimeConfig) {
  assertSafeAppId(appId);
  return path.join(config.backupsRootContainer ?? path.join(config.dataRootContainer, 'backups'), appId);
}

async function findBackupRecord(appId: string, backupId: string, config: HostRuntimeConfig) {
  const backupRoot = getBackupRoot(appId, config);
  const record = await readBackupRecord(path.join(backupRoot, `${backupId}.json`)).catch(() => null);
  return record?.appId === appId && record.id === backupId ? record : null;
}

async function readBackupRecord(metadataPath: string): Promise<AppDataBackupRecord> {
  const parsed = JSON.parse(await fs.readFile(metadataPath, 'utf-8')) as Partial<AppDataBackupRecord>;
  if (
    parsed.schemaVersion !== 'app-backup.0.1' ||
    !parsed.id ||
    !parsed.appId ||
    !parsed.reason ||
    !parsed.createdAt ||
    !parsed.dataPath ||
    !parsed.archivePath ||
    !parsed.archiveDigest
  ) {
    throw new Error(`Invalid backup metadata: ${metadataPath}`);
  }

  return {
    schemaVersion: 'app-backup.0.1',
    id: parsed.id,
    appId: parsed.appId,
    reason: parsed.reason,
    createdAt: parsed.createdAt,
    dataPath: parsed.dataPath,
    archivePath: parsed.archivePath,
    archiveDigest: parsed.archiveDigest,
    archiveBytes: parsed.archiveBytes ?? 0,
    fileCount: parsed.fileCount ?? 0,
  };
}

async function collectZipEntries(rootPath: string) {
  const entries: Array<{ name: string; data: Buffer }> = [];

  async function visit(directory: string) {
    const items = await fs.readdir(directory, { withFileTypes: true });
    for (const item of items) {
      const absolutePath = path.join(directory, item.name);
      const relativeName = toZipEntryName(path.relative(rootPath, absolutePath));
      if (item.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!item.isFile()) {
        continue;
      }

      entries.push({
        name: relativeName,
        data: await fs.readFile(absolutePath),
      });
    }
  }

  await visit(rootPath);
  return entries.sort((first, second) => first.name.localeCompare(second.name));
}

export function buildZipArchive(entries: Array<{ name: string; data: Buffer }>) {
  if (entries.length > 0xffff) {
    throw new AppBackupError(
      422,
      'backup_file_count_limit_exceeded',
      'App data backup contains too many files for the current ZIP archive format.'
    );
  }

  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf-8');
    if (name.byteLength > 0xffff) {
      throw new AppBackupError(422, 'backup_path_too_long', `Backup path "${entry.name}" is too long.`);
    }
    if (entry.data.byteLength > 0xffffffff) {
      throw new AppBackupError(422, 'backup_file_too_large', `Backup file "${entry.name}" is too large.`);
    }
    if (offset > 0xffffffff) {
      throw new AppBackupError(422, 'backup_archive_too_large', 'App data backup is too large for the current ZIP archive format.');
    }

    const crc = crc32(entry.data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt32LE(0, 10);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(entry.data.byteLength, 18);
    localHeader.writeUInt32LE(entry.data.byteLength, 22);
    localHeader.writeUInt16LE(name.byteLength, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, name, entry.data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt32LE(0, 12);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(entry.data.byteLength, 20);
    centralHeader.writeUInt32LE(entry.data.byteLength, 24);
    centralHeader.writeUInt16LE(name.byteLength, 28);
    centralHeader.writeUInt32LE(0, 30);
    centralHeader.writeUInt32LE(0, 34);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, name);
    offset += localHeader.byteLength + name.byteLength + entry.data.byteLength;
  }

  const centralDirectory = Buffer.concat(centralParts);
  if (centralDirectory.byteLength > 0xffffffff || offset > 0xffffffff) {
    throw new AppBackupError(422, 'backup_archive_too_large', 'App data backup is too large for the current ZIP archive format.');
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

async function extractZipArchive(archive: Buffer, destination: string) {
  const entries = readZipEntries(archive);
  const destinationRoot = path.resolve(destination);
  for (const entry of entries) {
    const relativePath = fromZipEntryName(entry.name);
    const targetPath = path.resolve(destinationRoot, relativePath);
    if (!isPathInside(destinationRoot, targetPath)) {
      throw new AppBackupError(422, 'backup_archive_path_invalid', `Backup archive entry "${entry.name}" is not safe.`);
    }

    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, entry.data);
  }
}

function readZipEntries(archive: Buffer) {
  const endOffset = findEndOfCentralDirectory(archive);
  const totalEntries = archive.readUInt16LE(endOffset + 10);
  const centralDirectoryOffset = archive.readUInt32LE(endOffset + 16);
  const entries: Array<{ name: string; data: Buffer }> = [];
  let offset = centralDirectoryOffset;

  for (let index = 0; index < totalEntries; index += 1) {
    if (archive.readUInt32LE(offset) !== 0x02014b50) {
      throw new AppBackupError(422, 'backup_archive_invalid', 'Backup archive central directory is invalid.');
    }

    const method = archive.readUInt16LE(offset + 10);
    if (method !== 0) {
      throw new AppBackupError(422, 'backup_archive_unsupported', 'Backup archive uses unsupported compression.');
    }

    const crc = archive.readUInt32LE(offset + 16);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localHeaderOffset = archive.readUInt32LE(offset + 42);
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf-8');
    if (archive.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new AppBackupError(422, 'backup_archive_invalid', `Backup archive entry "${name}" has an invalid local header.`);
    }
    const localNameLength = archive.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = archive.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const data = archive.subarray(dataStart, dataStart + compressedSize);

    if (crc32(data) !== crc) {
      throw new AppBackupError(422, 'backup_archive_crc_mismatch', `Backup archive entry "${name}" failed CRC verification.`);
    }

    entries.push({ name, data });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function findEndOfCentralDirectory(archive: Buffer) {
  for (let offset = archive.byteLength - 22; offset >= 0; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }

  throw new AppBackupError(422, 'backup_archive_invalid', 'Backup archive is not a valid ZIP file.');
}

function verifyArchiveDigest(archive: Buffer, backup: AppDataBackupRecord) {
  const digest = `sha256:${createHash('sha256').update(archive).digest('hex')}`;
  if (digest !== backup.archiveDigest) {
    throw new AppBackupError(422, 'backup_archive_digest_mismatch', `Backup "${backup.id}" failed digest verification.`);
  }
}

function toZipEntryName(relativePath: string) {
  const normalized = relativePath.split(path.sep).join('/');
  const segments = splitZipPathSegments(normalized);
  if (!normalized || normalized.startsWith('/') || hasUnsafeZipPathSegment(segments)) {
    throw new AppBackupError(422, 'backup_path_invalid', `Backup path "${relativePath}" is not safe.`);
  }

  return normalized;
}

function fromZipEntryName(name: string) {
  const segments = splitZipPathSegments(name);
  if (!name || name.startsWith('/') || name.includes('\0') || hasUnsafeZipPathSegment(segments)) {
    throw new AppBackupError(422, 'backup_archive_path_invalid', `Backup archive entry "${name}" is not safe.`);
  }

  return name.split('/').join(path.sep);
}

function formatBackupTimestamp(value: string) {
  return value.replace(/[:.]/g, '-');
}

function splitZipPathSegments(value: string) {
  return value.split(/[\\/]+/);
}

function hasUnsafeZipPathSegment(segments: string[]) {
  return segments.some(segment => segment === '..');
}

function isPathInside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertSafeAppId(appId: string) {
  if (!/^[a-z0-9][a-z0-9.-]{0,127}$/.test(appId)) {
    throw new AppBackupError(422, 'app_id_invalid', 'App id is not a safe Hosty app identifier.');
  }
}

const CRC32_TABLE = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let current = index;
  for (let bit = 0; bit < 8; bit += 1) {
    current = current & 1 ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
  }
  CRC32_TABLE[index] = current >>> 0;
}

function crc32(data: Buffer) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}
