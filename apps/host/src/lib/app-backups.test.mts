import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  APP_BACKUP_MAX_DATA_BYTES,
  buildZipArchive,
  createAppDataBackup,
  listAppDataBackups,
  restoreAppDataBackup,
  resolveAppDataDirectory,
} from './app-backups.ts';
import type { HostRuntimeConfig } from './host-runtime.ts';

test('creates, lists, and restores ZIP backups for an app data directory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hosty-backups-'));
  const config = createConfig(root);
  const dataPath = path.join(root, 'apps', 'com.example.notes', 'data');
  await fs.mkdir(path.join(dataPath, 'nested'), { recursive: true });
  await fs.writeFile(path.join(dataPath, 'nested', 'note.txt'), 'before', 'utf-8');

  const backup = await createAppDataBackup('com.example.notes', 'manual', config);
  assert.equal(backup?.reason, 'manual');
  assert.equal(backup?.fileCount, 1);

  const backups = await listAppDataBackups('com.example.notes', config);
  assert.equal(backups.length, 1);
  assert.equal(backups[0]?.id, backup?.id);

  await fs.writeFile(path.join(dataPath, 'nested', 'note.txt'), 'after', 'utf-8');
  await restoreAppDataBackup('com.example.notes', backup!.id, {
    stopBeforeRestore: false,
    createPreRestoreBackup: true,
  }, config);

  assert.equal(await fs.readFile(path.join(dataPath, 'nested', 'note.txt'), 'utf-8'), 'before');
  const backupsAfterRestore = await listAppDataBackups('com.example.notes', config);
  assert.equal(backupsAfterRestore.length, 2);
  assert.equal(backupsAfterRestore.some(candidate => candidate.reason === 'pre-restore'), true);
});

test('resolves legacy data mappings only inside the Host data root', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hosty-backups-'));
  const config = createConfig(root);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'modules.json'), `${JSON.stringify({
    schemaVersion: '0.2',
    hostSettings: {},
    modules: [{
      id: 'com.example.legacy',
      metadataUrl: 'https://apps.example.test/legacy/metadata.json',
      containers: [],
      storageMappings: [{
        key: 'data',
        container: 'app',
        containerPath: '/app/data',
        hostPath: path.join(root, 'modules', 'com.example.legacy', 'data'),
        writable: true,
      }],
    }],
  })}\n`, 'utf-8');

  assert.equal(
    await resolveAppDataDirectory('com.example.legacy', config),
    path.join(root, 'modules', 'com.example.legacy', 'data')
  );
});

test('creates unique backup ids for rapid backups', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hosty-backups-'));
  const config = createConfig(root);
  const dataPath = path.join(root, 'apps', 'com.example.notes', 'data');
  await fs.mkdir(dataPath, { recursive: true });
  await fs.writeFile(path.join(dataPath, 'note.txt'), 'content', 'utf-8');

  const first = await createAppDataBackup('com.example.notes', 'manual', config);
  const second = await createAppDataBackup('com.example.notes', 'manual', config);

  assert.ok(first);
  assert.ok(second);
  assert.notEqual(first.id, second.id);
});

test('restore rejects backup archives with traversal path segments', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hosty-backups-'));
  const config = createConfig(root);
  const appId = 'com.example.notes';
  const backupId = 'malicious';
  const dataPath = path.join(root, 'apps', appId, 'data');
  const backupRoot = path.join(root, 'backups', appId);
  await fs.mkdir(dataPath, { recursive: true });
  await fs.mkdir(backupRoot, { recursive: true });
  await fs.writeFile(path.join(dataPath, 'note.txt'), 'safe', 'utf-8');

  const archive = buildZipArchive([{ name: 'nested/../escape.txt', data: Buffer.from('bad') }]);
  const archivePath = path.join(backupRoot, `${backupId}.zip`);
  await fs.writeFile(archivePath, archive);
  await fs.writeFile(path.join(backupRoot, `${backupId}.json`), `${JSON.stringify({
    schemaVersion: 'app-backup.0.1',
    id: backupId,
    appId,
    reason: 'manual',
    createdAt: new Date().toISOString(),
    dataPath,
    archivePath,
    archiveDigest: `sha256:${createHash('sha256').update(archive).digest('hex')}`,
    archiveBytes: archive.byteLength,
    fileCount: 1,
  }, null, 2)}\n`, 'utf-8');

  await assert.rejects(
    () => restoreAppDataBackup(appId, backupId, {
      stopBeforeRestore: false,
      createPreRestoreBackup: false,
    }, config),
    { code: 'backup_archive_path_invalid' }
  );
  assert.equal(await fs.readFile(path.join(dataPath, 'note.txt'), 'utf-8'), 'safe');
  await assert.rejects(() => fs.access(path.join(root, 'apps', appId, 'escape.txt')));
  assert.deepEqual(
    (await fs.readdir(path.dirname(dataPath))).filter(name => name.includes('.restore-')),
    []
  );
});

test('ZIP archive creation rejects more than 65535 entries', () => {
  const entries = Array.from({ length: 0x10000 }, (_, index) => ({
    name: `file-${index}.txt`,
    data: Buffer.alloc(0),
  }));

  assert.throws(
    () => buildZipArchive(entries),
    { code: 'backup_file_count_limit_exceeded' }
  );
});

test('backup rejects app data above the current in-memory archive limit', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hosty-backups-'));
  const config = createConfig(root);
  const appId = 'com.example.notes';
  const dataPath = path.join(root, 'apps', appId, 'data');
  const largeFilePath = path.join(dataPath, 'too-large.bin');
  await fs.mkdir(dataPath, { recursive: true });
  await fs.writeFile(largeFilePath, '');
  await fs.truncate(largeFilePath, APP_BACKUP_MAX_DATA_BYTES + 1);

  await assert.rejects(
    () => createAppDataBackup(appId, 'manual', config),
    { code: 'backup_data_too_large' }
  );
  await assert.rejects(() => fs.access(path.join(root, 'backups', appId)));
});

function createConfig(root: string): HostRuntimeConfig {
  return {
    dataRootHost: root,
    dataRootContainer: root,
    dataRootMarkerPath: path.join(root, '.owner'),
    dataRootExpectedMarker: null,
    appsRootContainer: path.join(root, 'apps'),
    appsStorePath: path.join(root, 'apps.json'),
    backupsRootContainer: path.join(root, 'backups'),
    modulesRootContainer: path.join(root, 'modules'),
    modulesStorePath: path.join(root, 'modules.json'),
    authRootContainer: path.join(root, 'auth'),
    authStatePath: path.join(root, 'auth', 'state.json'),
    authAuditPath: path.join(root, 'auth', 'audit.json'),
    gatewayRootContainer: path.join(root, 'gateway'),
    gatewayExposuresPath: path.join(root, 'gateway', 'exposures.json'),
    gatewayBaseDomain: null,
    hostPublicOrigin: null,
    hostInternalOrigin: 'http://host.docker.internal:3000',
    dockerSocketPath: '/var/run/docker.sock',
    moduleNetwork: 'docker-host-modules',
  };
}
