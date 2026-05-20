import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertSecureEnoughForCookies,
  getRequestOrigin,
  isLoopbackRequest,
} from './auth-http.ts';

test('request origin ignores spoofed forwarded host when no public origin is configured', t => {
  const previousPublicOrigin = process.env.HOST_PUBLIC_ORIGIN;
  delete process.env.HOST_PUBLIC_ORIGIN;
  t.after(() => {
    restoreEnvValue('HOST_PUBLIC_ORIGIN', previousPublicOrigin);
  });

  const request = new Request('http://docker-host:3000/api/modules', {
    headers: {
      host: 'host.example.test',
      'x-forwarded-host': 'attacker.example.test',
      'x-forwarded-proto': 'https',
    },
  });

  assert.equal(getRequestOrigin(request), 'https://host.example.test');
});

test('configured public origin is the explicit proxy trust boundary', t => {
  const previousPublicOrigin = process.env.HOST_PUBLIC_ORIGIN;
  process.env.HOST_PUBLIC_ORIGIN = 'https://host.example.test/base';
  t.after(() => {
    restoreEnvValue('HOST_PUBLIC_ORIGIN', previousPublicOrigin);
  });

  const request = new Request('http://docker-host:3000/api/modules', {
    headers: {
      host: 'docker-host:3000',
      'x-forwarded-host': 'attacker.example.test',
      'x-forwarded-proto': 'http',
    },
  });

  assert.equal(getRequestOrigin(request), 'https://host.example.test');
});

test('loopback checks ignore spoofed forwarded host values', t => {
  const previousPublicOrigin = process.env.HOST_PUBLIC_ORIGIN;
  delete process.env.HOST_PUBLIC_ORIGIN;
  t.after(() => {
    restoreEnvValue('HOST_PUBLIC_ORIGIN', previousPublicOrigin);
  });

  const request = new Request('https://host.example.test/api/auth/dev-login', {
    headers: {
      host: 'host.example.test',
      'x-forwarded-host': 'localhost',
    },
  });

  assert.equal(isLoopbackRequest(request), false);
});

test('loopback checks use the server-observed remote address when available', () => {
  const spoofedHostRequest = new Request('http://localhost:3000/api/auth/dev-login', {
    headers: {
      host: 'localhost:3000',
      'x-docker-host-remote-address': '203.0.113.10',
    },
  });

  assert.equal(isLoopbackRequest(spoofedHostRequest), false);

  const localSocketRequest = new Request('http://host.example.test/api/auth/dev-login', {
    headers: {
      host: 'host.example.test',
      'x-docker-host-remote-address': '::ffff:127.0.0.1',
    },
  });

  assert.equal(isLoopbackRequest(localSocketRequest), true);
});

test('secure request checks normalize forwarded proto chains', () => {
  const request = new Request('http://host.example.test/api/auth/login', {
    headers: {
      'x-docker-host-remote-address': '203.0.113.10',
      'x-forwarded-proto': ' HTTPS, http',
    },
  });

  assert.doesNotThrow(() => assertSecureEnoughForCookies(request));
});

function restoreEnvValue(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}
