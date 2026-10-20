import { createHash } from 'node:crypto';
import { copyFileSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const firmwareFiles = [
  'hosty-cardputer.bin', 'hosty-cardputer-bootloader.bin',
  'hosty-cardputer-partition-table.bin', 'hosty-cardputer-ota-data.bin',
];

export function verifyCardputer(directory, sourceSha, outputDirectory) {
  if (!/^[0-9a-f]{40}$/.test(sourceSha ?? '')) throw new Error('Expected a full source SHA.');
  const root = realpathSync(directory);
  const readRegular = name => {
    const path = join(root, name);
    if (!lstatSync(path).isFile() || dirname(realpathSync(path)) !== root) {
      throw new Error(`Firmware artifact must be a regular file: ${name}`);
    }
    return readFileSync(path);
  };
  const verification = JSON.parse(readRegular('verification.json').toString('utf8'));
  if (verification.format !== 1 || verification.sourceSha !== sourceSha) {
    throw new Error('Firmware verification manifest does not match the validated main SHA and format.');
  }
  const checksums = new Map();
  for (const line of readRegular('SHA256SUMS').toString('utf8').trim().split('\n')) {
    const match = /^([a-f0-9]{64}) [ *](.+)$/.exec(line);
    if (!match || !firmwareFiles.includes(match[2]) || checksums.has(match[2])) {
      throw new Error('Firmware checksums must cover each expected release file exactly once.');
    }
    checksums.set(match[2], match[1]);
  }
  if (checksums.size !== firmwareFiles.length) throw new Error('Incomplete firmware checksum manifest.');
  for (const name of firmwareFiles) {
    const bytes = readRegular(name);
    if (bytes.length === 0 || (name === 'hosty-cardputer.bin' && bytes.length > 0x3d0000)) {
      throw new Error(`Firmware file is empty or exceeds the OTA slot: ${name}`);
    }
    if (createHash('sha256').update(bytes).digest('hex') !== checksums.get(name)) {
      throw new Error(`Firmware checksum mismatch: ${name}`);
    }
  }
  if (resolve(outputDirectory) === root) throw new Error('Release output must differ from downloaded evidence.');
  mkdirSync(outputDirectory, { recursive: true });
  for (const name of [...firmwareFiles, 'SHA256SUMS']) copyFileSync(join(root, name), join(outputDirectory, name));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { verifyCardputer(...process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
