#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const core = 'apps/core/src/Haas.Hosty.Core/Haas.Hosty.Core.csproj';
const cli = 'apps/cli/src/Haas.Hosty.Cli/Haas.Hosty.Cli.csproj';
const coreTests = 'apps/core/tests/Haas.Hosty.Core.Tests/Haas.Hosty.Core.Tests.csproj';
const cliTests = 'apps/cli/tests/Haas.Hosty.Cli.Tests/Haas.Hosty.Cli.Tests.csproj';
const windowsFilter = 'FullyQualifiedName~WindowsProcessControlTests|FullyQualifiedName~StopAsync_OnWindowsKillsAdoptedJobDescendantAfterShellExited|FullyQualifiedName~CoreDevelopmentTests|FullyQualifiedName~ExplicitStop|FullyQualifiedName~SourceDocuments_ReferenceMetadataSupportsLfAndCrLf|FullyQualifiedName~WorkspaceGit_|FullyQualifiedName~JsonStorageTests';
export const suites = Object.freeze(['activation', 'windows', 'transport', 'worker', 'whisper']);
const usage = 'Usage: npm run test:integration -- <' + suites.join('|') + '> [--dry-run]\n'
  + 'Runs one explicitly selected local suite. Builds its fixtures first; no automatic retries.\n'
  + 'activation: .NET, Git, Python, Docker; isolated managed Core Return and recovery\n'
  + 'windows: Windows and .NET; focused process, path and shared receipt tests\n'
  + 'transport: .NET, Python, Docker; isolated Core/container network checks\n'
  + 'worker: Docker; builds the manifest-matching worker image and checks its lifecycle\n'
  + 'whisper: .NET; downloads the pinned model and runs native CPU inference\n'
  + '--dry-run prints prerequisites and commands without running them.';

export function suitePlan(suite, { platform = process.platform, node = process.execPath,
  readManifest = () => JSON.parse(readFileSync(new URL('../apps/harness/manifest.json', import.meta.url), 'utf8')) } = {}) {
  if (!suites.includes(suite)) throw new Error('Unknown integration suite: ' + suite);
  if (suite === 'windows' && platform !== 'win32') throw new Error('The windows suite requires Windows; it cannot be verified on ' + platform + '.');
  const python = platform === 'win32' ? 'python' : 'python3';
  const command = (file, args, env = {}) => ({ file, args, env });
  const dotnet = command('dotnet', ['--version']);
  const docker = command('docker', ['info', '--format', '{{.ServerVersion}}']);
  const pythonCheck = command(python, ['--version']);
  const build = project => command('dotnet', ['build', project]);
  switch (suite) {
    case 'activation':
      return { prerequisites: [dotnet, command('git', ['--version']), pythonCheck, docker], steps: [
        build(core), build(cli),
        command(python, ['scripts/check-workspace-activation.py', '.', 'return', '--managed']),
        command(python, ['scripts/check-workspace-activation.py', '.', 'auto', '--managed']),
      ] };
    case 'windows':
      return { prerequisites: [dotnet, command('git', ['--version'])], steps: [
        command('dotnet', ['test', coreTests, '--filter', windowsFilter]),
        command('dotnet', ['test', cliTests, '--filter', 'FullyQualifiedName~SharedReceiptSharingTests']),
      ] };
    case 'transport':
      return { prerequisites: [dotnet, pythonCheck, docker], steps: [build(core),
        command(python, ['scripts/check-docker-core-transport.py', 'apps/core/src/Haas.Hosty.Core/bin/Debug/net10.0/hosty-core.dll']),
      ] };
    case 'worker': {
      const image = readManifest().services?.find(service => service.key === 'worker')?.runtimes?.docker?.image;
      if (typeof image !== 'string' || !image || image.startsWith('-') || /\s/.test(image)) throw new Error('Missing or invalid worker image in apps/harness/manifest.json.');
      return { prerequisites: [docker], steps: [
        command('docker', ['build', '-f', 'apps/harness/worker/Dockerfile', '-t', image, '.']),
        command(node, ['scripts/check-harness-worker.mjs']),
      ] };
    }
    case 'whisper':
      return { prerequisites: [dotnet], steps: [command('dotnet', [
        'test', 'apps/whisper/Hosty.Whisper.Tests/Hosty.Whisper.Tests.csproj', '--filter', 'FullyQualifiedName~NativeSpeechTests',
      ], { HOSTY_WHISPER_INTEGRATION: '1' })] };
  }
}

function display(step) {
  return [...Object.entries(step.env).map(([key, value]) => key + '=' + value), step.file, ...step.args]
    .map(value => /[\s|{}]/.test(value) ? JSON.stringify(value) : value).join(' ');
}

export function main(args, { platform = process.platform, env = process.env, cwd = root,
  run = spawnSync, log = console.log, readManifest } = {}) {
  if (!args.length || (args.length === 1 && ['--help', '-h'].includes(args[0]))) { log(usage); return 0; }
  if (args.length > 2 || (args[1] && args[1] !== '--dry-run')) { log(usage); return 2; }
  let plan;
  try { plan = suitePlan(args[0], { platform, readManifest }); }
  catch (error) { log(error.message); return 2; }
  const dryRun = args[1] === '--dry-run';
  if (!dryRun && env.GITHUB_ACTIONS === 'true') { log('Integration suites run locally, outside GitHub Actions.'); return 2; }
  log('Local integration: ' + args[0] + ' (' + platform + ')');
  for (const [label, steps] of [['Prerequisite', plan.prerequisites], ['Run', plan.steps]]) {
    for (const step of steps) {
      log(label + ': ' + display(step));
      if (dryRun) continue;
      const result = run(step.file, step.args, { cwd, env: { ...env, ...step.env }, stdio: 'inherit',
        ...(label === 'Prerequisite' ? { timeout: 30_000 } : {}) });
      if (result.error || result.signal || result.status !== 0) {
        log(label + ' failed: ' + (result.error?.message ?? result.signal ?? 'exit ' + result.status));
        return Number.isInteger(result.status) && result.status > 0 ? result.status : 1;
      }
    }
  }
  log(dryRun ? 'Preview only; no checks were executed.' : 'Selected local suite passed.');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
