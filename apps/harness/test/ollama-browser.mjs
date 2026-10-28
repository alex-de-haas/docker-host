// Normal Core login and real Harness provider administration. Credentials arrive on stdin.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
const { chromium } = await import(process.env.HOSTY_OLLAMA_PLAYWRIGHT_MODULE || 'playwright');
let input = ''; for await (const chunk of process.stdin) input += chunk;
const config = JSON.parse(input); input = '';
const browser = await chromium.launch({ headless: true, channel: process.env.HOSTY_OLLAMA_BROWSER_CHANNEL || 'chrome' });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage(); const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(config.core + '/login?returnTo=%2Fapi%2Fauth%2Fsession'); config.core = new URL(page.url()).origin;
  await page.getByLabel('Email', { exact: true }).fill(config.email);
  await page.getByLabel('Password', { exact: true }).fill(config.password); config.password = '';
  await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname === '/login' && r.request().method() === 'POST'), page.getByRole('button', { name: 'Sign in', exact: true }).click()]);
  const identity = await (await page.request.get(config.core + '/api/auth/session')).json(); assert.equal(identity.authenticated, true);
  const csrf = await (await page.request.get(config.core + '/api/auth/csrf')).json();
  const verifier = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
  const code = await page.request.post(config.core + '/api/apps/hosty.harness/launch-code', { headers: { Origin: config.core, 'X-Hosty-CSRF': csrf.token },
    data: { redirectUri: config.link, codeChallenge: createHash('sha256').update(verifier).digest('base64url'), codeChallengeMethod: 'S256' } });
  assert.equal(code.status(), 200);
  const exchange = await page.request.post(config.harness + '/api/auth/app-code', { headers: { Origin: config.harness }, data: { code: (await code.json()).code, codeVerifier: verifier } }); assert.equal(exchange.status(), 200);

  await page.goto(config.harness + '/settings/providers/');
  await page.getByRole('button', { name: '+ Add provider', exact: true }).click();
  await page.getByLabel('Provider', { exact: true }).click();
  await page.getByRole('option', { name: 'Ollama', exact: true }).click();
  await page.getByLabel('Connection name', { exact: true }).fill('Browser Ollama');
  const url = page.getByLabel('Ollama server URL', { exact: true });
  assert.equal(await url.getAttribute('placeholder'), 'http://127.0.0.1:11434');
  assert.equal(await page.locator('#connection-secret').count(), 0);
  await url.fill(config.ollama);
  await page.getByRole('button', { name: 'Save provider', exact: true }).click();
  const actions = page.getByRole('button', { name: 'Actions for Browser Ollama', exact: true });
  await actions.waitFor();
  await actions.click();
  await page.getByRole('menuitem', { name: 'Test connection', exact: true }).click();
  await page.getByText('Browser Ollama: Ollama is reachable from Worker.', { exact: true }).waitFor();
  await actions.click();
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  assert.equal(await url.inputValue(), config.ollama);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.deepEqual(errors, []);
  console.log('PASS: normal Core browser login, Ollama provider form, URL persistence and Worker connection test without a credential field.');
} finally { await browser.close(); }
