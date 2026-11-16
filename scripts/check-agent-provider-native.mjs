#!/usr/bin/env node
// Provider-owned native process/control fixtures. Default execution uses injected fake CLIs only.
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
if (args.some(argument => argument !== '--installed-clis') || new Set(args).size !== args.length) {
  console.error('Usage: node scripts/check-agent-provider-native.mjs [--installed-clis]'); process.exitCode = 2;
} else {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hosty-native-acceptance-'));
  try {
    const home = path.join(root, 'home'); mkdirSync(home, { mode: 0o700 });
    const environment = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
    Object.assign(environment, { HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, 'codex'), CLAUDE_CONFIG_DIR: path.join(home, 'claude'),
      XDG_CONFIG_HOME: path.join(home, 'config'), NODE_ENV: 'test', HOSTY_TEST_PROVIDER_INSTALLED_CLI: args.includes('--installed-clis') ? '1' : '0',
      GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' });
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', 'test/worker-native.mjs', 'test/worker-native-controls.mjs'], {
      cwd: fileURLToPath(new URL('../packages/agent-provider-runtime/', import.meta.url)), env: environment, stdio: 'inherit', timeout: 120000,
    });
    if (result.error) throw result.error;
    if (result.signal) throw new Error(`Native provider fixtures ended with ${result.signal}.`);
    process.exitCode = result.status ?? 1;
  } finally { rmSync(root, { recursive: true, force: true }); }
}
