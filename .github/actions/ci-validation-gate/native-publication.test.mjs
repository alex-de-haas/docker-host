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

function publish({ existing = true, succeeds = true, assets = [], listSucceeds = true, deleteFailsFor = '' } = {}) {
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
      '  "release view")',
      '    [ "$RELEASE_EXISTS" = 1 ] || exit 1',
      '    if [ "$4" = --json ]; then',
      '      [ "$LIST_SUCCEEDS" = 1 ] || exit 1',
      '      printf "%s\\n" "$RELEASE_ASSETS"',
      '    fi ;;',
      '  "release delete-asset") [ "$4" != "$DELETE_FAILS_FOR" ] ;;',
      '  "release upload"|"release create") [ "$UPLOAD_SUCCEEDS" = 1 ] ;;',
      '  "release edit") cp release-notes.md "$RECEIPT_FILE" ;;',
      '  *) exit 1 ;;',
      'esac', '',
    ].join('\n'), { mode: 0o755 });
    const result = spawnSync('bash', ['-c', script], {
      cwd: dir, encoding: 'utf8',
      env: { ...process.env, PATH: bin + ':' + process.env.PATH, PUBLISH_SOURCE_SHA: source,
        COMMAND_LOG: commands, RECEIPT_FILE: receipt,
        RELEASE_EXISTS: existing ? '1' : '0', UPLOAD_SUCCEEDS: succeeds ? '1' : '0',
        RELEASE_ASSETS: assets.join('\n'), LIST_SUCCEEDS: listSucceeds ? '1' : '0', DELETE_FAILS_FOR: deleteFailsFor },
    });
    return { result, calls: readFileSync(commands, 'utf8').trim().split('\n'),
      receipt: existsSync(receipt) ? readFileSync(receipt, 'utf8') : null };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const existing of [true, false]) {
  for (const succeeds of [true, false]) {
    test('release receipt follows all uploads: existing=' + existing + ', succeeds=' + succeeds, () => {
      const { result, calls, receipt } = publish({ existing, succeeds });
      assert.equal(result.status, succeeds ? 0 : 1, result.stderr);
      assert.ok(calls.some(call => call.startsWith(existing ? 'release upload ' : 'release create ')));
      assert.equal(calls.some(call => call.startsWith('release delete-asset ')), false);
      if (succeeds) {
        assert.ok(calls.at(-1).startsWith('release edit '));
        assert.match(receipt, new RegExp('^Published commit: ' + source + '$', 'm'));
      } else {
        assert.equal(receipt, null, 'failed publication cannot advance the receipt');
        assert.equal(calls.some(call => call.startsWith('release edit ')), false);
      }
    });
  }
}

const retired = ['hosty-darwin-x64', 'hosty-core-darwin-x64'];
for (const assets of [retired, [retired[0]], [retired[1]], []]) {
  test('cleanup removes only present retired assets before upload: ' + assets.join(', '), () => {
    const { result, calls, receipt } = publish({ assets: ['hosty-darwin-arm64', ...assets, 'SHA256SUMS', 'VERSION'] });
    assert.equal(result.status, 0, result.stderr);
    const deletions = calls.filter(call => call.startsWith('release delete-asset '));
    assert.deepEqual(deletions, assets.map(asset => 'release delete-asset cli-dev ' + asset + ' --yes'));
    const uploadIndex = calls.findIndex(call => call.startsWith('release upload '));
    assert.ok(uploadIndex >= 0);
    for (const deletion of deletions) assert.ok(calls.indexOf(deletion) < uploadIndex);
    assert.ok(calls.at(-1).startsWith('release edit '));
    assert.match(receipt, new RegExp('^Published commit: ' + source + '$', 'm'));
  });
}

for (const failure of [{ listSucceeds: false }, ...retired.map(deleteFailsFor => ({ deleteFailsFor }))]) {
  test('cleanup failure stops uploads and preserves the prior receipt: ' + JSON.stringify(failure), () => {
    const { result, calls, receipt } = publish({ assets: retired, ...failure });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(calls.some(call => /^release (upload|create|edit) /.test(call)), false);
    assert.equal(receipt, null);
  });
}

test('only the native publisher opts into cumulative Core/CLI recovery', () => {
  assert.match(workflow, /components: core,cli\n          native-release-tag: cli-dev/);
  assert.match(workflow, /group: cli-dev-release\n      cancel-in-progress: false/);
  assert.ok(workflow.indexOf('uses: ./.github/actions/publish-guard') < workflow.indexOf('gh release upload'));
});
