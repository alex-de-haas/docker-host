import { afterEach, expect, it, vi } from 'vitest';
import { createAppAuthAttempt } from '@hosty-sdk/app/browser-auth';
import { providerSignInUrl } from './settings-auth.mjs';
afterEach(()=>vi.unstubAllGlobals());
it('creates a Core app sign-in URL accepted by the actual browser SDK',()=>{
  const origin='http://unrelated-provider.hosty.localhost:3521';vi.stubGlobal('window',{location:{origin}});
  const url=providerSignInUrl({appId:'unrelated.provider',corePublicOrigin:'http://core.hosty.localhost:31863'},origin);
  const attempt=createAppAuthAttempt(url,'popup',2);
  expect(attempt.appId).toBe('unrelated.provider');expect(new URL(attempt.redirectUri).origin).toBe(origin);
  expect(new URL(attempt.redirectUri).pathname).toBe('/settings');expect(attempt.codeVerifier.length).toBeGreaterThan(32);
});
it('does not carry a previous proof, hash or another app return URL into renewal',()=>{
  const url=new URL(providerSignInUrl({appId:'another-provider',corePublicOrigin:'https://core.example'},'https://provider.example'));
  expect(url.searchParams.get('redirectUri')).toBe('https://provider.example/settings');
  expect([...url.searchParams.keys()]).toEqual(['redirectUri']);
});
