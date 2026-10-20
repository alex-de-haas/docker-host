import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDockerFaultProxy } from './docker-fault-proxy.mjs';
if (process.env.HOSTY_TEST_DOCKER_DEVELOPMENT !== '1') throw new Error('Explicitly enable HOSTY_TEST_DOCKER_DEVELOPMENT=1 for disposable Core integration tests.');
const repository = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const upstream = !process.env.DOCKER_CONTEXT && process.env.DOCKER_HOST || execFileSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], { encoding: 'utf8' }).trim();
if (!upstream.startsWith('unix://')) throw new Error('This acceptance runner requires the existing local Unix Docker endpoint.');
// Unix-domain paths have a small platform limit; do not place the socket inside a Core worktree.
const temporary = await mkdtemp('/tmp/hosty-fault-');
const manifest = JSON.parse(await readFile(path.join(repository, 'apps/harness/manifest.json'), 'utf8'));
const imageIds = Object.fromEntries([['worker-image', manifest.agentWorker.image], ['coordinator-image', manifest.services[0].runtimes.docker.image]].map(([mode, image]) => [mode, execFileSync('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], { encoding: 'utf8' }).trim()]));
const proxy = await startDockerFaultProxy(path.join(temporary, 'docker.sock'), upstream.slice(7), imageIds);
const configFile = path.join(temporary, 'control.json');
await writeFile(configFile, JSON.stringify({ origin: proxy.origin, token: proxy.token }), { mode: 0o600 });
const env = { ...process.env, DOCKER_HOST: 'unix://' + path.join(temporary, 'docker.sock'), HOSTY_TEST_DOCKER_FAULT_CONTROL: configFile, HOSTY_TEST_DOCKER_UPSTREAM: upstream,
  HOSTY_TEST_HARNESS_REPOSITORY: repository, HOSTY_TEST_HARNESS_ACCEPTANCE_HOOK: path.join(repository, 'scripts/experiments/harness-production/failures.mjs') };
delete env.DOCKER_CONTEXT;
let code = 1;
try {
  const child = spawn('dotnet', ['test', 'apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj', '--artifacts-path', 'artifacts/harness-runtime-final', '--no-build', '--filter', 'FullyQualifiedName~Harness_ProductionDockerRunsCoreOwnedWorkerAndFinishesSandbox'], { cwd: repository, env, stdio: 'inherit' });
  code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (status, signal) => resolve(signal ? 1 : status ?? 1)); });
} finally {
  const report = process.env.HOSTY_TEST_HARNESS_FAILURE_REPORT;
  if (report) await writeFile(report + '.proxy.json', JSON.stringify({ faults: proxy.hits }), { mode: 0o600 });
  await proxy.close(); await rm(temporary, { recursive: true, force: true });
}
process.exitCode = code;
