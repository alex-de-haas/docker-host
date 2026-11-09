// Normal child Core password login and real Harness session/queue. Durable prediction events and
// action replies below are browser-memory fixtures: UI evidence, not backend persistence or inference.
// Credentials arrive on stdin and are never printed or written to artifacts.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
const { chromium } = await import(process.env.HOSTY_SUGGESTIONS_PLAYWRIGHT_MODULE || 'playwright');
let input = ''; for await (const chunk of process.stdin) input += chunk;
const config = JSON.parse(input); input = '';
assert.ok(typeof config.appId === 'string' && config.appId, 'Provide the discovered installed Harness application id.');
const browser = await chromium.launch({ headless: true, channel: process.env.HOSTY_SUGGESTIONS_BROWSER_CHANNEL || 'chrome' });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage(), errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(config.core + '/login?returnTo=%2Fapi%2Fauth%2Fsession'); config.core = new URL(page.url()).origin;
  await page.getByLabel('Email', { exact: true }).fill(config.email);
  await page.getByLabel('Password', { exact: true }).fill(config.password); config.password = '';
  await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname === '/login' && r.request().method() === 'POST'), page.getByRole('button', { name: 'Sign in', exact: true }).click()]);
  const identity = await (await page.request.get(config.core + '/api/auth/session')).json(); assert.equal(identity.authenticated, true);
  const csrf = await (await page.request.get(config.core + '/api/auth/csrf')).json();
  const verifier = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
  const code = await page.request.post(`${config.core}/api/apps/${encodeURIComponent(config.appId)}/launch-code`, { headers: { Origin: config.core, 'X-Hosty-CSRF': csrf.token },
    data: { redirectUri: config.link, codeChallenge: createHash('sha256').update(verifier).digest('base64url'), codeChallengeMethod: 'S256' } });
  assert.equal(code.status(), 200);
  const exchange = await page.request.post(config.harness + '/api/auth/app-code', { headers: { Origin: config.harness }, data: { code: (await code.json()).code, codeVerifier: verifier } }); assert.equal(exchange.status(), 200);
  const response = await page.request.post(config.harness + '/api/sessions', { headers: { Origin: config.harness }, data: { title: 'Suggestion history browser acceptance' } });
  assert.equal(response.status(), 200); const session = await response.json(), owner = session.createdBy; assert.ok(owner);
  let sends = 0;
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && (path.endsWith('/messages') || path.endsWith('/message-queue/commands') && request.postDataJSON()?.command?.type === 'enqueue')) sends++;
  });
  const events = [], values = new Map(), receipts = new Map(), actionInputs = [];
  let sequence = 100, socket, connected, loseReply = false;
  const sendFixture = event => socket?.send(`data: ${JSON.stringify(event)}\n\n`);
  const appendFixture = payload => {
    const event = { ...payload, seq: ++sequence, ts: new Date().toISOString() }; events.push(event); sendFixture(event); return event;
  };
  await page.route('**/api/sessions/*/suggestions**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (!url.pathname.includes(`/sessions/${session.id}/suggestions`)) return route.continue();
    const reply = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (request.method() === 'GET') return reply(200, [...values.values()]);
    const match = url.pathname.match(/\/suggestions\/([^/]+)\/actions$/);
    if (request.method() !== 'POST' || !match) return route.continue();
    const input = request.postDataJSON(), id = match[1], stamp = JSON.stringify([id, input]); actionInputs.push(input);
    const previous = receipts.get(input.requestId);
    if (previous) return previous.stamp === stamp ? reply(200, previous.result) : reply(409, { code: 'suggestion_request_conflict', message: 'Fixture request changed.' });
    const value = values.get(id);
    if (!value || value.state !== 'available' || input.expectedRevision !== value.revision) return reply(409, { code: 'suggestion_changed', message: 'Fixture choice already recorded.' });
    assert.match(input.requestId, /^[0-9a-f-]{36}$/i); assert.ok(['selected-for-draft', 'dismissed'].includes(input.action));
    const result = { ...value, state: input.action, revision: 2, resolvedAt: new Date().toISOString() };
    values.set(id, result); receipts.set(input.requestId, { stamp, result });
    appendFixture({ type: 'prompt_suggestion_resolved', suggestionId: id, state: input.action });
    if (loseReply) { loseReply = false; return route.abort('failed'); }
    return reply(200, result);
  });
  await page.routeWebSocket('**/api/event-stream', route => {
    const server = route.connectToServer(); let replayed = false;
    server.onMessage(message => {
      route.send(message);
      if (String(message).includes('"type":"session_status"') && !replayed) {
        replayed = true; socket = route;
        for (const event of events) sendFixture(event);
        connected?.();
      }
    });
  });
  const open = async (mode = 'standalone') => {
    socket = undefined; let timer;
    const streamReady = new Promise((resolve, reject) => { connected = resolve; timer = setTimeout(() => reject(new Error('Conversation stream did not connect')), 30000); });
    const queueReady = page.waitForResponse(response => new URL(response.url()).pathname.endsWith(`/sessions/${session.id}/message-queue`) && response.ok(), { timeout: 30000 });
    try {
      const url = new URL(config.preview || `${config.harness}/assistant/`);
      url.searchParams.set('session', session.id); url.searchParams.set('hosty_launch', mode);
      await page.goto(url.href); await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor(); await Promise.all([streamReady, queueReady]);
    } finally { clearTimeout(timer); }
  };
  const emit = async text => {
    for (const value of values.values()) if (value.state === 'available') {
      value.state = 'superseded'; value.revision = 2; appendFixture({ type: 'prompt_suggestion_resolved', suggestionId: value.suggestionId, state: 'superseded' });
    }
    const suggestionId = randomUUID(), answer = appendFixture({ type: 'assistant_text', text: 'Controlled completed answer.' });
    const event = appendFixture({ type: 'prompt_suggestion_created', suggestionId, sessionId: session.id, userId: owner,
      attemptId: randomUUID(), answerSeq: answer.seq, text, expiresAt: Date.now() + 600000 });
    values.set(suggestionId, { ...event, createdAt: event.ts, state: 'available', revision: 1 });
    await page.getByRole('button', { name: /Use suggestion/ }).waitFor();
    return suggestionId;
  };
  await open();
  const message = page.getByRole('textbox', { name: 'Message', exact: true });
  await emit('Review @app <script>literally</script>');
  const card = page.locator('[data-slot="prompt-suggestion"]').last();
  assert.equal(await card.locator('script').count(), 0);
  assert.ok(await card.evaluate(node => !!node.closest('[aria-label="Conversation messages"]') && !node.closest('[aria-label="Message composer"]')));
  await message.focus(); await message.press('Shift+Tab'); assert.equal(await message.inputValue(), '');
  await message.focus(); await message.press('Tab'); await page.waitForFunction(() => document.querySelector('textarea[aria-label="Message"]')?.value === 'Review @app <script>literally</script>');
  assert.ok((await card.textContent()).includes('Selected for draft')); assert.equal(sends, 0);
  await message.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z'); assert.equal(await message.inputValue(), '');
  assert.equal(await page.getByRole('button', { name: /Use suggestion/ }).count(), 0);
  await emit('Suggestion with an existing draft'); await message.fill('Preserve my text');
  assert.equal(await page.getByRole('button', { name: /Use suggestion/ }).isDisabled(), true);
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-slot="prompt-suggestion"]')].some(node => node.textContent.includes('Dismissed')));
  await message.fill(''); await open();
  assert.equal(await page.locator('[data-slot="prompt-suggestion"]').count(), 2);
  assert.ok((await page.locator('[data-slot="prompt-suggestion"]').last().textContent()).includes('Dismissed'));
  assert.equal(await page.getByRole('button', { name: /Use suggestion/ }).count(), 0);
  await emit('Recover the same selection'); loseReply = true;
  await page.getByRole('button', { name: /Use suggestion/ }).click();
  await page.getByRole('button', { name: 'Retry insertion', exact: true }).waitFor();
  const original = actionInputs.at(-1); assert.equal(await message.inputValue(), '');
  await page.getByRole('button', { name: 'Retry insertion', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="Message"]')?.value === 'Recover the same selection');
  assert.deepEqual(actionInputs.at(-1), original); await message.fill('');
  await open('embedded'); await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ colorScheme: 'dark' });
  await emit('Проверить изменения');
  assert.ok(await page.locator('html').evaluate(node => node.scrollWidth <= innerWidth));
  if (process.env.HOSTY_SUGGESTIONS_SCREENSHOT) await page.screenshot({ path: process.env.HOSTY_SUGGESTIONS_SCREENSHOT, fullPage: true });
  await page.getByRole('button', { name: /Use suggestion/ }).click();
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="Message"]')?.value === 'Проверить изменения');
  await open('embedded'); assert.equal(await message.inputValue(), 'Проверить изменения'); assert.equal(sends, 0);
  assert.deepEqual(errors, []);
  console.log('PASS: normal child Core login, durable transcript-card UI, recorded choices/replay, guarded draft-only acceptance, same-UUID lost-reply recovery, undo, mobile dark layout and no automatic sends (controlled browser-memory fixtures; backend durability and native inference are separate checks).');
} finally { await browser.close(); }
