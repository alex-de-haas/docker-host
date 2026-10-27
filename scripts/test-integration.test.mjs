import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { main, suitePlan, suites } from './test-integration.mjs';

const manifest = () => ({ services: [{ key: 'api', runtimes: { docker: { image: 'example/harness:1.2.3' } } }, { key: 'worker', runtimes: { docker: { image: 'example/worker:1.2.3' } } }] });
const options = { platform: 'darwin', env: {}, log() {}, readManifest: manifest };

test('help, invalid input and dry-run never start processes', () => {
  const noRun = { ...options, run: () => assert.fail('unexpected process') };
  assert.equal(main([], noRun), 0);
  assert.equal(main(['--help'], noRun), 0);
  assert.equal(main(['all'], noRun), 2);
  assert.equal(main(['activation', '--unknown'], noRun), 2);
  assert.equal(main(['worker', '--dry-run', 'extra'], noRun), 2);
  for (const suite of suites) assert.equal(main([suite, '--dry-run'], { ...noRun, platform: 'win32' }), 0);
});

test('unsupported Windows acceptance refuses before any process starts', () => {
  assert.equal(main(['windows'], { ...options, run: () => assert.fail('unexpected process') }), 2);
  const plan = suitePlan('windows', { platform: 'win32' });
  assert.equal(plan.steps.length, 2);
  assert.match(plan.steps[0].args.at(-1), /WindowsProcessControlTests/);
  assert.match(plan.steps[1].args.at(-1), /SharedReceiptSharingTests/);
});

test('activation uses the host Python and managed isolated scenarios after builds', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const plan = suitePlan('activation', { platform });
    assert.deepEqual(plan.steps.slice(0, 2).map(step => step.args[0]), ['build', 'build']);
    assert.deepEqual(plan.steps.slice(2).map(step => step.args.slice(1)), [['.', 'return', '--managed'], ['.', 'auto', '--managed']]);
    assert.equal(plan.steps[2].file, platform === 'win32' ? 'python' : 'python3');
    assert.ok(plan.prerequisites.some(step => step.file === 'docker'));
  }
});

test('worker uses the declared service image, without an npm install or host tsx dependency', () => {
  const plan = suitePlan('worker', { readManifest: manifest, node: '/path with space/node' });
  assert.equal(plan.steps[0].args[4], 'example/worker:1.2.3');
  assert.deepEqual(plan.steps[1], { file: '/path with space/node', args: ['scripts/check-harness-worker.mjs'], env: {} });
  assert.throws(() => suitePlan('worker', { readManifest: () => ({}) }), /worker image/);
});

test('preflight failure prevents builds and runtime work, preserves exit status and never retries', () => {
  const calls = [];
  const code = main(['activation'], { ...options, run(file) { calls.push(file); return { status: 7 }; } });
  assert.equal(code, 7);
  assert.deepEqual(calls, ['dotnet']);
});

test('failed scenario stops remaining work; paths and arguments are passed without a shell', () => {
  const calls = [];
  const code = main(['activation'], { ...options, cwd: '/workspace with spaces', run(file, args, opts) {
    calls.push({ file, args });
    assert.equal(opts.cwd, '/workspace with spaces');
    assert.equal(opts.shell, undefined);
    return { status: args.includes('return') ? 23 : 0 };
  } });
  assert.equal(code, 23);
  assert.ok(!calls.some(call => call.args.includes('auto')));
});

test('missing binaries and terminated processes fail instead of reporting success', () => {
  for (const result of [{ error: new Error('ENOENT'), status: null }, { signal: 'SIGTERM', status: null }, { status: null }]) {
    assert.equal(main(['whisper'], { ...options, run: () => result }), 1);
  }
});

test('native inference is opt-in and preserves caller environment without modifying it', () => {
  const env = { HOSTY_WHISPER_TEST_CACHE: '/cache', PATH: '/bin' };
  let inference = 0;
  assert.equal(main(['whisper'], { ...options, env, run(file, args, opts) {
    if (args[0] === 'test') {
      inference++;
      assert.equal(opts.env.HOSTY_WHISPER_INTEGRATION, '1');
      assert.equal(opts.env.HOSTY_WHISPER_TEST_CACHE, '/cache');
      assert.deepEqual(args.slice(-2), ['--filter', 'FullyQualifiedName~NativeSpeechTests']);
    }
    return { status: 0 };
  } }), 0);
  assert.equal(inference, 1);
  assert.equal(env.HOSTY_WHISPER_INTEGRATION, undefined);
});

test('OPUS builds before inference, uses uv, and opts in without requiring Docker', () => {
  const plan = suitePlan('opus', { node: '/node with spaces' });
  assert.deepEqual(plan.prerequisites.map(step => step.file), ['/node with spaces', 'uv']);
  assert.deepEqual(plan.steps[0].args, ['apps/opus/scripts/build.mjs']);
  assert.equal(plan.steps[1].env.HOSTY_OPUS_INTEGRATION, '1');
  assert.ok(plan.steps.every(step => step.file === '/node with spaces'));
});

test('GitHub Actions cannot accidentally opt into the local runtime suites', () => {
  assert.equal(main(['activation'], { ...options, env: { GITHUB_ACTIONS: 'true' }, run: () => assert.fail('unexpected process') }), 2);
});

test('console entry point returns a nonzero exit for an invalid suite', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./test-integration.mjs', import.meta.url)), 'all'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /Unknown integration suite/);
});

test('Harness local acceptance uses managed Core and the native runtime without building Docker app images', () => {
  const plan = suitePlan('harness-local', { platform: 'darwin' });
  assert.deepEqual(plan.steps.slice(0, 2).map(step => step.args[0]), ['build', 'build']);
  assert.deepEqual(plan.steps[2].args, ['scripts/check-workspace-activation.py', '.', 'harness-local', '--managed']);
  assert.ok(plan.prerequisites.some(step => step.args.some(arg => arg.includes('npm --version'))));
  assert.ok(!plan.steps.some(step => step.file === 'docker'));
});
