import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeToolchain } from './native-toolchain.mjs';
import { identity } from './context.mjs';

test('Linux native evidence resolves the actual linker and records system library versions', () => {
  const answers = { 'dotnet --info': 'SDK 10.0', 'which clang': '/usr/bin/clang',
    '/resolved/usr/bin/clang -print-prog-name=ld': 'ld.lld', 'which ld.lld': '/usr/bin/ld.lld',
    '/resolved/usr/bin/clang --version': 'clang 20' };
  const run = (file, args) => file === 'dpkg-query' ? 'zlib=2\nlibc=3\n' : answers[[file, ...args].join(' ')];
  let compiler = 'compiler bytes';
  const options = { platform: 'linux', env: {}, run, realpath: p => '/resolved' + p,
    read: p => p === '/etc/os-release' ? 'Ubuntu' : Buffer.from(p.endsWith('clang') ? compiler : 'linker') };
  const evidence = nativeToolchain(options);
  assert.equal(evidence.linker.path, '/resolved/usr/bin/ld.lld');
  assert.deepEqual(evidence.systemPackages, ['libc=3','zlib=2']);
  compiler = 'patched compiler'; assert.notEqual(identity(nativeToolchain(options)), identity(evidence));
});

test('Windows evidence uses the selected C++ toolset and highest numeric installed SDK', () => {
  const options = { platform: 'win32', env: { 'ProgramFiles(x86)': '/program-files', ImageOS: 'win25' },
    run: file => file === 'dotnet' ? 'SDK 10.0' : '/visual-studio',
    read: (path, encoding) => encoding ? '14.42\n' : Buffer.from(path),
    list: () => ['10.0.9.0', 'not-an-sdk', '10.0.26100.0'] };
  const evidence = nativeToolchain(options);
  assert.equal(evidence.windowsSdk, '10.0.26100.0');
  assert.ok(evidence.compiler.path.includes('/14.42/bin/Hostx64/x64/cl.exe'));
  assert.equal(evidence.libraries.length, 2);
  assert.throws(() => nativeToolchain({ ...options, list: () => [] }), /SDK was not found/);
  assert.throws(() => nativeToolchain({ ...options, env: {} }), /root is missing/);
});
