// Requires the locally built manifest-matching image. Uses no provider credentials or model turns.
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const manifest = JSON.parse(await readFile(new URL('../apps/harness/manifest.json', import.meta.url), 'utf8'));
const image = manifest.services.find(service => service.key === 'worker').runtimes.docker.image;
execFileSync('docker', ['run', '--rm', '--init', '--network', 'none',
  '-e', 'HOSTY_TEST_WORKER_NATIVE=1', '--entrypoint', 'node', image,
  '--import', 'tsx', '--test', 'test/worker-native.mjs'], {stdio:'inherit'});
execFileSync('docker', ['run', '--rm', '--init', '--network', 'none', '--entrypoint', 'node', image,
  '--import', 'tsx', 'test/worker-native-controls.mjs'], {stdio:'inherit', timeout:90000});
