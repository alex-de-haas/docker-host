import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const workflow = readFileSync(new URL('../../workflows/cli-release.yml', import.meta.url), 'utf8');
const script = workflow.split('      - name: Publish rolling prerelease\n')[1]
  .split('        run: |\n')[1].split('\n').map(line => line.replace(/^          /, '')).join('\n');
const source = 'a'.repeat(40);

for (const existing of [true, false]) {
  for (const succeeds of [true, false]) {
    test('release receipt follows all uploads: existing=' + existing + ', succeeds=' + succeeds, () => {
      const dir = mkdtempSync(join(tmpdir(), 'hosty-release-receipt-'));
      try {
        const bin = join(dir, 'bin'), commands = join(dir, 'commands'), receipt = join(dir, 'receipt');
        mkdirSync(bin);
        mkdirSync(join(dir, 'dist'));
        writeFileSync(join(dir, 'dist', 'hosty-test'), 'test asset');
        writeFileSync(join(bin, 'git'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        writeFileSync(join(bin, 'gh'), [
          '#!/bin/sh',
          'printf "%s\\n" "$*" >> "$COMMAND_LOG"',
          'case "$1 $2" in',
          '  "release view") [ "$RELEASE_EXISTS" = 1 ] ;;',
          '  "release upload"|"release create") [ "$UPLOAD_SUCCEEDS" = 1 ] ;;',
          '  "release edit") cp release-notes.md "$RECEIPT_FILE" ;;',
          '  *) exit 1 ;;',
          'esac', '',
        ].join('\n'), { mode: 0o755 });
        const result = spawnSync('bash', ['-c', script], {
          cwd: dir, encoding: 'utf8',
          env: { ...process.env, PATH: bin + ':' + process.env.PATH, PUBLISH_SOURCE_SHA: source,
            COMMAND_LOG: commands, RECEIPT_FILE: receipt,
            RELEASE_EXISTS: existing ? '1' : '0', UPLOAD_SUCCEEDS: succeeds ? '1' : '0' },
        });
        assert.equal(result.status, succeeds ? 0 : 1, result.stderr);
        const calls = readFileSync(commands, 'utf8').trim().split('\n');
        assert.ok(calls[1].startsWith(existing ? 'release upload ' : 'release create '));
        if (succeeds) {
          assert.ok(calls.at(-1).startsWith('release edit '));
          assert.match(readFileSync(receipt, 'utf8'), new RegExp('^Published commit: ' + source + '$', 'm'));
        } else {
          assert.equal(existsSync(receipt), false, 'failed publication cannot advance the receipt');
          assert.equal(calls.some(call => call.startsWith('release edit ')), false);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}

test('only the native publisher opts into cumulative Core/CLI recovery', () => {
  assert.match(workflow, /components: core,cli\n          native-release-tag: cli-dev/);
  assert.match(workflow, /group: cli-dev-release\n      cancel-in-progress: false/);
  assert.ok(workflow.indexOf('uses: ./.github/actions/publish-guard') < workflow.indexOf('gh release upload'));
});
