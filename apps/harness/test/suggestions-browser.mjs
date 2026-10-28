// Normal Core login and real Harness data; only prediction SSE is a controlled UI fixture.
// This is composer acceptance, not evidence of live provider inference. Credentials arrive on stdin.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
const { chromium } = await import(process.env.HOSTY_SUGGESTIONS_PLAYWRIGHT_MODULE || 'playwright');
let input = ''; for await (const chunk of process.stdin) input += chunk;
const config = JSON.parse(input); input = '';
const browser = await chromium.launch({ headless: true, channel: process.env.HOSTY_SUGGESTIONS_BROWSER_CHANNEL || 'chrome' });
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
  const response = await page.request.post(config.harness + '/api/sessions', { headers: { Origin: config.harness }, data: { title: 'Suggestion browser acceptance' } });
  assert.equal(response.status(), 200); const session = await response.json();
  const owner = session.createdBy; assert.ok(owner);
  let messages = 0; page.on('request', r => { if (r.method() === 'POST' && new URL(r.url()).pathname.endsWith('/messages')) messages++; });
  let socket, connected;
  await page.routeWebSocket('**/api/event-stream', route => {
    const server = route.connectToServer();
    server.onMessage(message => {
      route.send(message);
      if (String(message).includes('"type":"session_status"')) { socket = route; connected?.(); }
    });
  });
  const open = async mode => {
    socket = undefined;
    let timer;
    const ready = new Promise((resolve, reject) => { connected = resolve; timer = setTimeout(() => reject(new Error('Conversation stream did not connect')), 30000); });
    try {
      await page.goto(`${config.harness}/assistant/?session=${session.id}&hosty_launch=${mode}`);
      await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor(); await ready;
    } finally { clearTimeout(timer); }
  };
  let revision = 0;
  const sendFixture = value => socket.send(`data: ${JSON.stringify(value)}\n\n`);
  const emit = async text => {
    revision++;
    sendFixture({ type: 'user_message', seq: revision * 2, ts: new Date().toISOString(), text: 'Controlled next-turn context' });
    sendFixture({ type: 'session_suggestion', seq: -2, ts: new Date().toISOString(), epoch: 'browser-fixture',
      sessionId: session.id, userId: owner, attemptId: `attempt-${revision}`, revision, state: 'available', text, expiresAt: Date.now() + 60000 });
  };
  await open('standalone');
  const message = page.getByRole('textbox', { name: 'Message', exact: true });
  await emit('Review @hosty.harness literally');
  await page.getByRole('button', { name: /Use suggestion/ }).waitFor();
  await message.focus(); await message.press('Shift+Tab'); assert.equal(await message.inputValue(), '');
  await message.focus(); await message.press('Tab'); assert.equal(await message.inputValue(), 'Review @hosty.harness literally'); assert.equal(messages, 0);
  await message.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z'); assert.equal(await message.inputValue(), '');
  assert.equal(await page.getByRole('button', { name: /Use suggestion/ }).count(), 0);
  await emit('Another suggestion'); await page.getByRole('button', { name: /Use suggestion/ }).waitFor();
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await open('standalone');
  sendFixture({ type: 'session_suggestion', seq: -2, ts: '', epoch: 'browser-fixture', sessionId: session.id, userId: owner,
    attemptId: `attempt-${revision}`, revision, state: 'available', text: 'Another suggestion', expiresAt: Date.now()+60000 });
  assert.equal(await page.getByRole('button', { name: /Use suggestion/ }).count(), 0);
  await open('embedded'); await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ colorScheme: 'dark' });
  await emit('Проверить изменения'); await page.getByRole('button', { name: /Use suggestion/ }).waitFor();
  assert.ok(await page.locator('html').evaluate(node => node.scrollWidth <= innerWidth));
  if (process.env.HOSTY_SUGGESTIONS_SCREENSHOT) await page.screenshot({ path: process.env.HOSTY_SUGGESTIONS_SCREENSHOT, fullPage: true });
  await page.getByRole('button', { name: /Use suggestion/ }).click(); assert.equal(await message.inputValue(), 'Проверить изменения'); assert.equal(messages, 0);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="Message"]')?.value === 'Проверить изменения');
  assert.equal(await message.inputValue(), 'Проверить изменения');
  assert.deepEqual(errors, []);
  console.log('PASS: normal Core browser login, suggestion draft acceptance, keyboard undo, dismissal/reload, embedded mobile dark layout and no automatic sends (controlled SSE fixture).');
} finally { await browser.close(); }
