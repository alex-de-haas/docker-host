import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { firmwareFiles, verifyCardputer } from './verify-cardputer.mjs';
import { prepareCardputer } from './prepare-cardputer.mjs';

const sha = 'a'.repeat(40);
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ci-cardputer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, 'release');
  for (const name of firmwareFiles) writeFileSync(join(root, name), `firmware: ${name}`);
  writeFileSync(join(root, 'verification.json'), JSON.stringify({ format: 1, sourceSha: sha }));
  const checksum = name => createHash('sha256').update(readFileSync(join(root, name))).digest('hex');
  const manifest = firmwareFiles.map(name => `${checksum(name)}  ${name}`).join('\n') + '\n';
  writeFileSync(join(root, 'SHA256SUMS'), manifest);
  return { root, output, manifest };
}

test('publishes the complete verified exact-SHA firmware without rebuilding or renaming', t => {
  const { root, output } = fixture(t);
  verifyCardputer(root, sha, output);
  for (const name of [...firmwareFiles, 'SHA256SUMS']) assert.deepEqual(readFileSync(join(output, name)), readFileSync(join(root, name)));
  assert.equal(existsSync(join(output, 'verification.json')), false);
});

for (const evidence of [{ format: 1, sourceSha: 'b'.repeat(40) }, { format: 2, sourceSha: sha }, { sourceSha: sha }]) {
  test(`rejects mismatched source evidence ${JSON.stringify(evidence)}`, t => {
    const { root, output } = fixture(t);
    writeFileSync(join(root, 'verification.json'), JSON.stringify(evidence));
    assert.throws(() => verifyCardputer(root, sha, output), /does not match/);
    assert.equal(existsSync(output), false);
  });
}

for (const name of firmwareFiles) {
  test(`cannot publish an incomplete or corrupt binary: ${name}`, t => {
    const { root, output } = fixture(t);
    writeFileSync(join(root, name), 'corrupt');
    assert.throws(() => verifyCardputer(root, sha, output), /checksum mismatch/);
    rmSync(join(root, name));
    assert.throws(() => verifyCardputer(root, sha, output), /ENOENT/);
    assert.equal(existsSync(output), false);
  });
}

for (const mutation of ['missing', 'duplicate', 'extra', 'traversal']) {
  test(`rejects ${mutation} checksum coverage`, t => {
    const { root, output, manifest } = fixture(t);
    const lines = manifest.trim().split('\n');
    const changed = mutation === 'missing' ? lines.slice(1).join('\n')
      : mutation === 'duplicate' ? manifest + lines[0] + '\n'
        : manifest + `${'a'.repeat(64)}  ${mutation === 'extra' ? 'extra.bin' : '../outside.bin'}\n`;
    writeFileSync(join(root, 'SHA256SUMS'), changed);
    assert.throws(() => verifyCardputer(root, sha, output), /checksum/);
    assert.equal(existsSync(output), false);
  });
}

test('rejects linked firmware and oversized or empty application images before preparing output', t => {
  const { root, output } = fixture(t);
  const image = join(root, firmwareFiles[0]);
  rmSync(image);
  symlinkSync(join(root, firmwareFiles[1]), image);
  assert.throws(() => verifyCardputer(root, sha, output), /regular file/);
  rmSync(image);
  writeFileSync(image, Buffer.alloc(0x3d0001));
  assert.throws(() => verifyCardputer(root, sha, output), /OTA slot/);
  writeFileSync(image, '');
  assert.throws(() => verifyCardputer(root, sha, output), /empty/);
  assert.equal(existsSync(output), false);
});

test('manual recovery prepares complete exact-SHA firmware and still uses the common verifier', t => {
  const { root, output } = fixture(t);
  const build = join(root, 'build');
  mkdirSync(join(build, 'bootloader'), { recursive: true });
  mkdirSync(join(build, 'partition_table'));
  const buildFiles = ['hosty_cardputer_shell.bin', 'bootloader/bootloader.bin',
    'partition_table/partition-table.bin', 'ota_data_initial.bin'];
  for (const [index, name] of buildFiles.entries()) writeFileSync(join(build, name), `manually built firmware ${index}`);
  const evidence = join(root, 'manual-evidence');
  prepareCardputer(build, sha, evidence);
  verifyCardputer(evidence, sha, output);
  for (const [index, name] of firmwareFiles.entries()) assert.equal(readFileSync(join(output, name), 'utf8'), `manually built firmware ${index}`);
  writeFileSync(join(evidence, firmwareFiles[0]), 'corrupt after preparation');
  assert.throws(() => verifyCardputer(evidence, sha, join(root, 'second-release')), /checksum mismatch/);
  assert.equal(existsSync(join(root, 'second-release')), false);
});

test('manual recovery cannot turn an incomplete build into publishable firmware', t => {
  const { root } = fixture(t);
  const build = join(root, 'incomplete-build');
  mkdirSync(build);
  writeFileSync(join(build, 'hosty_cardputer_shell.bin'), 'only the application');
  const evidence = join(root, 'incomplete-evidence');
  assert.throws(() => prepareCardputer(build, sha, evidence), /ENOENT/);
  assert.throws(() => verifyCardputer(evidence, sha, join(root, 'failed-release')), /ENOENT/);
  assert.equal(existsSync(join(root, 'failed-release')), false);
});
