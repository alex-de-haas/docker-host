// Normal Core login and real provider-owned administration. Credentials arrive on stdin.
import assert from 'node:assert/strict';
import { authenticateProvider, authenticateHarness, harnessProviderConnection } from './provider-browser.mjs';
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
  await authenticateProvider(context, config.core, csrf.token, config.provider);
  await page.goto(config.provider.origin + '/settings');
  await page.getByRole('heading', { name: 'Ollama provider', exact: true }).waitFor();
  await page.getByLabel('Name', { exact: true }).fill('Browser Ollama');
  const url = page.getByLabel('Ollama server URL', { exact: true });
  assert.equal(await url.getAttribute('placeholder'), 'http://127.0.0.1:11434');
  assert.equal(await page.locator('#secret').isVisible(), false);
  await url.fill(config.ollama);
  await page.getByRole('button', { name: 'Save connection', exact: true }).click();
  const card = page.locator('article').filter({ has: page.getByRole('heading', { name: /Browser Ollama/, exact: false }) });
  await card.waitFor();
  await card.getByRole('button', { name: 'Edit', exact: true }).click();
  assert.equal(await url.inputValue(), config.ollama);
  await page.getByRole('button', { name: 'New connection', exact: true }).click();
  // Sign into Harness separately; a provider app proof cannot authenticate another app.
  await authenticateHarness(context, config.core, csrf.token, config);
  const connection = await harnessProviderConnection(context, config.harness, config.provider, 'Browser Ollama');
  const checked = await context.request.post(config.harness + '/api/connections/' + connection.id + '/test', { headers: { Origin: config.harness }, data: {} });
  assert.equal(checked.status(), 200); assert.equal((await checked.json()).available, true);
  assert.deepEqual(errors, []);
  console.log('PASS: normal Core browser login, provider-owned Ollama settings, URL persistence and Harness discovery without a credential field.');
} finally { await browser.close(); }
