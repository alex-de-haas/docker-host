// Normal child Core password login and a real installed Harness. Native observations below are
// controlled browser fixtures: UI/replay evidence, not native inference or backend persistence.
// Credentials arrive on stdin and are never printed or written to artifacts.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
const { chromium } = await import(process.env.HOSTY_NATIVE_SUBAGENTS_PLAYWRIGHT_MODULE || 'playwright');
let input = ''; for await (const chunk of process.stdin) input += chunk;
const config = JSON.parse(input); input = '';
assert.ok(typeof config.appId === 'string' && config.appId, 'Provide the discovered installed Harness application id.');
const browser = await chromium.launch({ headless: true, channel: process.env.HOSTY_NATIVE_SUBAGENTS_BROWSER_CHANNEL || 'chrome' });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'Europe/Amsterdam' });
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
  const response = await page.request.post(config.harness + '/api/sessions', { headers: { Origin: config.harness }, data: { title: 'Native subagents browser acceptance' } });
  assert.equal(response.status(), 200); const session = await response.json(), owner = session.createdBy; assert.ok(owner);

  const events = []; let sequence = 100, socket, connected;
  const send = event => socket?.send(`data: ${JSON.stringify(event)}\n\n`);
  const append = payload => {
    const event = { seq: ++sequence, ts: '2026-11-17T13:24:12.000Z', ...payload };
    if (event.type !== 'assistant_delta') events.push(event);
    send(event); return event;
  };
  await page.routeWebSocket('**/api/event-stream', route => {
    const server = route.connectToServer(); let replayed = false;
    server.onMessage(message => {
      if (String(message).includes('"type":"session_status"') && !replayed) {
        replayed = true; socket = route;
        for (const event of events) send(event);
        route.send(message); connected?.();
      } else route.send(message);
    });
  });
  const open = async embedded => {
    socket = undefined; let timer;
    const stream = new Promise((resolve, reject) => { connected = resolve; timer = setTimeout(() => reject(new Error('Conversation stream did not connect')), 30000); });
    const queue = page.waitForResponse(r => new URL(r.url()).pathname.endsWith(`/sessions/${session.id}/message-queue`) && r.ok());
    const url = new URL(embedded ? `${config.harness}/assistant/` : config.link);
    url.searchParams.set('session', session.id); url.searchParams.set('hosty_launch', embedded ? 'embedded' : 'standalone');
    try { await page.goto(url.href); await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor(); await Promise.all([stream, queue]); }
    finally { clearTimeout(timer); }
  };
  const root = { provider: { appId: 'independent.test.provider', installationId: 'test-install', key: 'default' }, runId: 'test-run', generation: 'test-generation', agentId: 'root' };
  const source = id => ({ ...root, agentId: id, parentAgentId: 'root', parentToolCallId: `spawn-${id}`, parentTranscriptToolUseId: `spawn-${id}` });
  const status = (id, state, extra = {}) => append({ type: 'native_agent_status', providerSource: source(id), state,
    stopConfirmed: ['succeeded', 'failed', 'cancelled'].includes(state), freshness: 'current', observedAt: '2026-11-17T13:24:12.000Z', ...extra });
  await open(false);
  append({ type: 'user_message', text: 'Research memory, delegation and notifications.' });
  for (const [id, description] of [['memory', 'Memory research'], ['delegation', 'Delegation research'], ['notifications', 'Notification research']]) {
    append({ type: 'tool_use', toolName: 'Agent', toolUseId: `spawn-${id}`, input: { description, run_in_background: true }, providerSource: root });
    status(id, 'running');
  }
  const panel = page.getByRole('region', { name: 'Provider subagents' });
  await panel.getByRole('button', { name: 'Memory research: Running. Show output' }).waitFor();
  assert.equal(await panel.count(), 1);
  assert.equal(await panel.getByRole('button', { name: /Running. Show output/ }).count(), 3);
  append({ type: 'assistant_delta', text: 'Root stream remains separate.', providerSource: root });
  append({ type: 'assistant_delta', text: 'Child stream remains attributed.', providerSource: source('memory') });
  await panel.getByRole('button', { name: /Memory research:/ }).click();
  await panel.getByText('Child stream remains attributed.', { exact: true }).waitFor();
  assert.equal(await panel.getByText('Root stream remains separate.', { exact: true }).count(), 0);
  append({ type: 'assistant_text', text: 'Memory child final answer.', providerSource: source('memory') });
  append({ type: 'assistant_text', text: 'Root waits for three research children.', providerSource: root });
  await panel.getByText('Memory child final answer.', { exact: true }).waitFor();
  assert.equal(await panel.getByText('Child stream remains attributed.', { exact: true }).count(), 0);
  assert.equal(await panel.getByText('Root waits for three research children.', { exact: true }).count(), 0);
  append({ type: 'approval_request', approvalId: 'child-approval', toolName: 'Write', input: { file_path: '/tmp/test-only.md', content: 'Fixture' }, title: 'Child requests a test edit', providerSource: source('delegation') });
  await page.getByText('Child requests a test edit', { exact: true }).waitFor();
  assert.equal(await panel.getByText('Child requests a test edit', { exact: true }).count(), 0);
  await page.getByText('From Delegation research', { exact: true }).waitFor();
  append({ type: 'approval_decision', approvalId: 'child-approval', decision: 'deny', providerSource: source('delegation') });
  status('memory', 'succeeded'); status('delegation', 'failed');
  status('notifications', 'unknown', { stopConfirmed: false, freshness: 'last_known', lastKnownState: 'running' });
  await panel.getByRole('button', { name: 'Memory research: Completed. Show output' }).waitFor();
  await panel.getByRole('button', { name: 'Delegation research: Failed. Show output' }).waitFor();
  await panel.getByRole('button', { name: 'Notification research: Unknown. Show output' }).waitFor();
  await panel.getByText('Last known: running', { exact: true }).waitFor();
  // Reconnect replays the same durable identities, without duplicate groups or false running badges.
  await open(false);
  await panel.getByRole('button', { name: 'Memory research: Completed. Show output' }).waitFor();
  assert.equal(await panel.count(), 1);
  assert.equal(await panel.getByRole('button', { name: /Show output/ }).count(), 3);
  await panel.getByRole('button', { name: /Memory research:/ }).click();
  assert.equal(await panel.getByText('Memory child final answer.', { exact: true }).count(), 1);
  // A later run may reuse native ids. Its identity must not merge into the preceding run.
  append({ type: 'native_agent_status', providerSource: { ...source('memory'), runId: 'second-run' }, state: 'cancelled', stopConfirmed: true, freshness: 'current', observedAt: '2026-11-17T13:25:12.000Z' });
  await page.getByRole('button', { name: /Subagent 1: Cancelled. Show output/ }).waitFor();
  assert.equal(await panel.count(), 2);
  const promptTime = page.locator('button:has(time[datetime="2026-11-17T13:24:12.000Z"])').first();
  assert.equal(await promptTime.locator('time').textContent(), '14:24');
  await promptTime.focus(); await promptTime.press('Enter');
  await page.getByRole('dialog').locator('time').waitFor(); await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ colorScheme: 'dark' });
  await open(true);
  await page.getByRole('button', { name: 'Memory research: Completed. Show output' }).waitFor();
  await promptTime.click(); await page.getByRole('dialog').locator('time').waitFor(); await page.keyboard.press('Escape');
  assert.ok(await page.locator('html').evaluate(node => node.scrollWidth <= innerWidth), 'No mobile horizontal overflow');
  if (process.env.HOSTY_NATIVE_SUBAGENTS_SCREENSHOT) await page.screenshot({ path: process.env.HOSTY_NATIVE_SUBAGENTS_SCREENSHOT, fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS: normal child Core password/app-code login, installed Harness standalone and embedded UI, three attributed children, independent root/child streams, visible child decision, terminal/unknown states, replay deduplication, reused ids across runs, local prompt time and keyboard/mobile timestamp details (controlled browser observations; native execution is a separate check).');
} finally { await browser.close(); }
