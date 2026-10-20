import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { firmwareFiles } from './verify-cardputer.mjs';

const buildFiles = [
  'hosty_cardputer_shell.bin', 'bootloader/bootloader.bin',
  'partition_table/partition-table.bin', 'ota_data_initial.bin',
];

// Explicit manual recovery prepares the same complete evidence contract as the producing CI job.
// The shared verifier still checks every byte before a release or attestation can be written.
export function prepareCardputer(buildDirectory, sourceSha, evidenceDirectory) {
  if (!/^[0-9a-f]{40}$/.test(sourceSha ?? '')) throw new Error('Expected a full source SHA.');
  mkdirSync(evidenceDirectory);
  const checksums = firmwareFiles.map((name, index) => {
    copyFileSync(join(buildDirectory, buildFiles[index]), join(evidenceDirectory, name));
    const digest = createHash('sha256').update(readFileSync(join(evidenceDirectory, name))).digest('hex');
    return `${digest}  ${name}`;
  });
  writeFileSync(join(evidenceDirectory, 'SHA256SUMS'), `${checksums.join('\n')}\n`);
  writeFileSync(join(evidenceDirectory, 'verification.json'), `${JSON.stringify({ sourceSha, format: 1 })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { prepareCardputer(...process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
