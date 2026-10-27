// Repeatable browser check invoked by tasks_acceptance.py. Passwords arrive only on stdin.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
const { chromium } = await import(process.env.HOSTY_TASKS_PLAYWRIGHT_MODULE || 'playwright');
let input = ''; for await (const chunk of process.stdin) input += chunk;
const config = JSON.parse(input); input = '';
const browser = await chromium.launch({ headless: true, ...(process.env.HOSTY_TASKS_BROWSER_CHANNEL ? { channel: process.env.HOSTY_TASKS_BROWSER_CHANNEL } : {}) });
const context = await browser.newContext({ viewport: { width: 1320, height: 950 } });
const page = await context.newPage();
const errors = []; page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(config.core + '/login?returnTo=%2Fapi%2Fauth%2Fsession');
  // Core redirects browser login to its canonical cookie origin. Use the observed destination.
  config.core = new URL(page.url()).origin;
  assert.match(await page.locator('body').ariaSnapshot(), /Email.*|Password/);
  await page.getByLabel('Email', { exact: true }).fill(config.email);
  await page.getByLabel('Password', { exact: true }).fill(config.password);
  config.password = '';
  await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname === '/login' && r.request().method() === 'POST'), page.getByRole('button', { name: 'Sign in', exact: true }).click()]);
  const identity = await (await page.request.get(config.core+'/api/auth/session')).json();
  assert.equal(identity.authenticated, true);
  const csrf = await (await page.request.get(config.core+'/api/auth/csrf')).json();
  const verifier = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
  const codeResponse = await page.request.post(config.core+'/api/apps/hosty.harness/launch-code', {
    headers: { Origin: config.core, 'X-Hosty-CSRF': csrf.token },
    data: { redirectUri: config.link, codeChallenge: createHash('sha256').update(verifier).digest('base64url'), codeChallengeMethod: 'S256' },
  });
  assert.equal(codeResponse.status(), 200);
  const exchange = await page.request.post(config.harness+'/api/auth/app-code', {
    headers: { Origin: config.harness }, data: { code: (await codeResponse.json()).code, codeVerifier: verifier },
  });
  assert.equal(exchange.status(), 200);
  await page.goto(config.harness+'/tasks/');
  await page.getByRole('heading', { name: 'Tasks', exact: true }).waitFor();
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('Browser lifecycle acceptance');
  await page.getByLabel('Description · Markdown', { exact: true }).fill('A task created through the UI.');
  const assignee = page.getByRole('combobox', { name: 'Assignee', exact: true });
  await assignee.locator('option[value="human:'+identity.user.id+'"]').waitFor({ state: 'attached' });
  await assignee.selectOption('human:'+identity.user.id);
  await page.getByLabel('Review result before completing').check();
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await page.getByRole('button', { name: 'Ready', exact: true }).waitFor();
  await page.getByLabel('Title', { exact: true }).fill('Unsaved browser title');
  const background = await page.request.post(config.harness+'/api/tasks/v1/tasks', {
    headers: { Origin: config.harness }, data: { requestId: randomUUID(), input: {
      title: 'SSE background task', markdown: 'Trigger a real stream update.', assignee: null, requiresReview: false, resources: [],
    } },
  });
  assert.equal(background.status(), 201);
  await page.getByRole('button', { name: /SSE background task/ }).waitFor();
  assert.equal(await page.getByLabel('Title', { exact: true }).inputValue(), 'Unsaved browser title');
  await page.getByRole('button', { name: 'Discard edits', exact: true }).click();
  await page.getByRole('button', { name: 'Ready', exact: true }).click();
  await page.getByRole('button', { name: 'Start work', exact: true }).click();
  await page.getByLabel('Result · Markdown', { exact: true }).fill('Verified from the browser.');
  await page.getByRole('button', { name: 'Submit result', exact: true }).click();
  await page.getByRole('button', { name: 'Accept result', exact: true }).click();
  await page.getByRole('button', { name: 'Reopen', exact: true }).waitFor();
  assert.match(await page.locator('main').innerText(), /Done/);
  assert.match(await page.locator('main').innerText(), /Verified from the browser/);
  assert.deepEqual(errors, []);
  if (process.env.HOSTY_TASKS_SCREENSHOT) {
    await mkdir(path.dirname(process.env.HOSTY_TASKS_SCREENSHOT), { recursive: true });
    await page.screenshot({ path: process.env.HOSTY_TASKS_SCREENSHOT, fullPage: true });
  }
  await page.reload();
  await page.getByRole('button', { name: /Browser lifecycle acceptance/ }).click();
  await page.getByRole('button', { name: 'Reopen', exact: true }).waitFor();
  console.log('PASS: Chromium password login, Core launch identity, UI create/start/review/result, SSE draft preservation and reload');
} catch (error) {
  console.error('Browser page:', new URL(page.url()).pathname);
  console.error('Browser errors:', errors);
  console.error('Assignee markup:', await page.getByRole('combobox', { name: 'Assignee', exact: true }).evaluate(el => el.outerHTML, undefined, { timeout: 1000 }).catch(() => 'unavailable'));
  console.error((await page.locator('body').ariaSnapshot()).slice(0, 12000));
  throw error;
} finally { await context.close(); await browser.close(); }
