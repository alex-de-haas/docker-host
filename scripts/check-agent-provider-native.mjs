#!/usr/bin/env node
// Provider-owned native fixtures use app-declared probes and disposable account directories.
import { mkdtempSync, mkdirSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { providerBuildConfig } from '../packages/agent-provider-runtime/scripts/build-config.mjs';

const args = process.argv.slice(2);
if (args.some(argument => argument !== '--installed-clis') || new Set(args).size !== args.length) {
  console.error('Usage: node scripts/check-agent-provider-native.mjs [--installed-clis]'); process.exitCode = 2;
} else {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hosty-native-acceptance-'));
  try {
    const repository = fileURLToPath(new URL('../', import.meta.url));
    const home = path.join(root, 'home'); mkdirSync(home, { mode: 0o700 });
    const environment = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
    Object.assign(environment, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, 'config'), NODE_ENV: 'test',
      HOSTY_TEST_PROVIDER_INSTALLED_CLI: args.includes('--installed-clis') ? '1' : '0', GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' });
    const commands = [{ cwd: path.join(repository, 'packages/agent-provider-runtime'), tests: ['test/worker-native.mjs'] }];
    for (const slug of readdirSync(path.join(repository, 'apps')).sort()) {
      if (!existsSync(path.join(repository, 'apps', slug, 'package.json'))) continue;
      const config = await providerBuildConfig(repository, slug);
      if (config.nativeTests.length) commands.push({ cwd: config.application, tests: config.nativeTests });
    }
    for (const command of commands) {
      const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...command.tests], {
        cwd: command.cwd, env: environment, stdio: 'inherit', timeout: 120000,
      });
      if (result.error) throw result.error;
      if (result.signal) throw new Error(`Native provider fixtures ended with ${result.signal}.`);
      if (result.status !== 0) { process.exitCode = result.status ?? 1; break; }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}
