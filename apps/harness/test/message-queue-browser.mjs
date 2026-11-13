// Real managed-Harness queue/browser acceptance. Core credentials arrive only on stdin.
// The owned HTTP fixture supplies deterministic Ollama replies; no external model is called.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
const { chromium } = await import(process.env.HOSTY_QUEUE_PLAYWRIGHT_MODULE || 'playwright');
let input = ''; for await (const chunk of process.stdin) input += chunk;
const config = JSON.parse(input); input = '';
assert.ok(typeof config.appId === 'string' && config.appId, 'Provide the discovered Harness app id.');
const token = randomUUID(), model = 'hosty-queue-fixture:latest', requests = [], fixtureErrors = [], pageErrors = [], states = new Set();
let releaseFirst;
const firstHeld = new Promise(resolve => { releaseFirst = resolve; });
const fixture = createServer((request, response) => {
  void (async () => {
    const reply = (value, stream = false) => {
      response.writeHead(200, { 'content-type': stream ? 'application/x-ndjson' : 'application/json' });
      response.end(JSON.stringify(value) + (stream ? '\n' : ''));
    };
    if (request.method === 'GET' && request.url === '/api/version') return reply({ version: 'queue-acceptance' });
    if (request.method === 'GET' && request.url === '/api/tags') return reply({ models: [{ name: model }] });
    let body = '', length = 0;
    for await (const chunk of request) {
      length += chunk.length; if (length > 4 * 1024 * 1024) throw new Error('Fixture input exceeded its bound.'); body += chunk;
    }
    const value = JSON.parse(body || '{}');
    if (request.method === 'POST' && request.url === '/api/show') return reply({ capabilities: ['completion', 'tools'], model_info: { 'fixture.context_length': 32768 } });
    assert.equal(request.method, 'POST'); assert.equal(request.url, '/api/chat'); assert.equal(value.model, model);
    requests.push(value); const turn = requests.length;
    if (turn === 1) await firstHeld;
    if (!response.destroyed) reply({ model, message: { role: 'assistant', content: `Queue fixture answer ${turn}` }, done: true, prompt_eval_count: 20, eval_count: 5 }, true);
  })().catch(() => { fixtureErrors.push('Controlled Ollama request failed.'); if (!response.destroyed) { response.statusCode = 500; response.end(); } });
});
fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening');
const address = fixture.address(); assert.ok(address && typeof address !== 'string');
const browser = await chromium.launch({ headless: true, channel: process.env.HOSTY_QUEUE_BROWSER_CHANNEL || 'chrome' });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
context.setDefaultTimeout(30000);
let preference;
const api = async (path, method = 'GET', data) => {
  const response = await context.request.fetch(config.harness + '/api' + path, { method, headers: { Origin: config.harness }, ...(data === undefined ? {} : { data }) });
  assert.ok(response.ok(), `${method} ${path.replace(/[a-f0-9-]{36}/g, ':id')} returned ${response.status()}`);
  return response.status() === 204 ? undefined : response.json();
};
const wait = async (read, check, label) => {
  const until = Date.now() + 60000;
  do { const value = await read(); if (check(value)) return value; await new Promise(resolve => setTimeout(resolve, 100)); } while (Date.now() < until);
  throw new Error(`Timed out: ${label}`);
};
const queuePath = session => `/sessions/${session.id}/message-queue`;
const queue = session => api(queuePath(session));
const command = async (session, value) => {
  const current = await queue(session);
  return api(queuePath(session) + '/commands', 'POST', { requestId: randomUUID(), expectedRevision: current.revision, command: value });
};
const watch = page => {
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('websocket', socket => socket.on('framereceived', frame => {
    for (const line of String(frame.payload).split('\n')) {
      if (!line.startsWith('data: ')) continue;
      try { const value = JSON.parse(line.slice(6)), event = value.event ?? value;
        if (event.type === 'session_message_queue') for (const entry of event.queue.entries) states.add(entry.state);
      } catch { /* Non-data transport frames are irrelevant to queue-state evidence. */ }
    }
  }));
};
const message = page => page.getByRole('textbox', { name: 'Message', exact: true });
const row = (page, index) => page.getByRole('listitem', { name: `Queued message ${index}`, exact: true });
const rows = page => page.getByRole('list', { name: 'Queued messages', exact: true }).getByRole('listitem');
const rowAction = async (page, index, name) => {
  await row(page, index).hover(); await row(page, index).getByRole('button', { name, exact: true }).click();
};
const open = async (page, session) => {
  const url = new URL(config.preview || config.harness + '/assistant/');
  url.searchParams.set('session', session.id); url.searchParams.set('hosty_launch', 'standalone');
  const loaded = page.waitForResponse(response => new URL(response.url()).pathname.endsWith(queuePath(session)) && response.ok());
  await page.goto(url.href); await message(page).waitFor(); await loaded;
};
const fill = async (page, text) => { await message(page).fill(text); };
const expectText = async (page, text) => {
  await page.waitForFunction(text => document.querySelector('textarea[aria-label="Message"]')?.value === text, text);
};
const file = async (page, name, text) => {
  await page.locator('[aria-label="Message composer"] input[type="file"]').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(text) });
};
const checkFiles = async (session, entry, expected) => {
  for (const [name, bytes] of Object.entries(expected)) {
    const attachment = entry.attachments.find(value => (value.displayName ?? value.name) === name); assert.ok(attachment, `Server lost ${name}.`);
    const response = await context.request.get(config.harness + '/api' + queuePath(session) + '/attachments/' + encodeURIComponent(attachment.id));
    assert.equal(response.status(), 200); assert.equal((await response.body()).toString(), bytes);
  }
};
const localFiles = async (page, expected) => wait(() => page.evaluate(async () => {
  const db = await new Promise((resolve, reject) => { const request = indexedDB.open('hosty.message-outbox.v1', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error('Cannot read saved browser queue.')); });
  try {
    const values = await new Promise((resolve, reject) => { const request = db.transaction('metadata', 'readonly').objectStore('metadata').getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error('Cannot read saved edit buffers.')); });
    const files = values.flatMap(value => [value?.stash, value?.buffer, ...(Array.isArray(value) ? value.map(saved => saved?.draft) : [])]).flatMap(draft => draft?.files ?? []);
    return Promise.all(files.map(async file => ({ name: file.name, text: await file.bytes.text() })));
  } finally { db.close(); }
}), values => Object.entries(expected).every(([name, text]) => values.some(file => file.name === name && file.text === text)), 'saved edit file bytes');
try {
  const page = await context.newPage(); watch(page);
  await page.goto(config.core + '/login?returnTo=%2Fapi%2Fauth%2Fsession'); config.core = new URL(page.url()).origin;
  await page.getByLabel('Email', { exact: true }).fill(config.email);
  await page.getByLabel('Password', { exact: true }).fill(config.password); config.password = '';
  await Promise.all([page.waitForResponse(response => new URL(response.url()).pathname === '/login' && response.request().method() === 'POST'), page.getByRole('button', { name: 'Sign in', exact: true }).click()]);
  assert.equal((await (await context.request.get(config.core + '/api/auth/session')).json()).authenticated, true);
  const csrf = await (await context.request.get(config.core + '/api/auth/csrf')).json();
  const verifier = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
  const issued = await context.request.post(`${config.core}/api/apps/${encodeURIComponent(config.appId)}/launch-code`, { headers: { Origin: config.core, 'X-Hosty-CSRF': csrf.token }, data: {
    redirectUri: config.link, codeChallenge: createHash('sha256').update(verifier).digest('base64url'), codeChallengeMethod: 'S256',
  } }); assert.equal(issued.status(), 200);
  const exchange = await context.request.post(config.harness + '/api/auth/app-code', { headers: { Origin: config.harness }, data: { code: (await issued.json()).code, codeVerifier: verifier } }); assert.equal(exchange.status(), 200);
  preference = await api('/preferences/prompt-suggestions');
  if (preference.enabled) await api('/preferences/prompt-suggestions', 'PUT', { enabled: false, revision: preference.revision });
  const connection = await api('/connections', 'POST', { name: 'Controlled queue acceptance ' + token, kind: 'ollama', auth: 'none', baseUrl: `http://127.0.0.1:${address.port}` });
  assert.equal((await api('/connections/' + connection.id + '/test', 'POST', {})).available, true);
  assert.equal((await api('/connections/' + connection.id + '/models')).defaultModel, model);
  const createSession = title => api('/sessions', 'POST', { title, connectionId: connection.id, profileId: null, skillIds: [], appIds: [], clientRequestId: randomUUID() });
  const session = await createSession('Queue browser acceptance'); await command(session, { type: 'pause' }); await open(page, session);
  const first = `First queued text ${token}\n${'Additional message text '.repeat(40).trimEnd()}`, second = `Second with file ${token}`, draft = `Unsent ordinary draft ${token}`;
  await fill(page, first); await page.getByRole('button', { name: 'Send', exact: true }).click();
  const one = await wait(() => queue(session), value => value.entries.length === 1, 'first queued entry');
  await expectText(page, ''); assert.equal(one.paused, true); assert.equal(one.entries[0].state, 'queued');
  await fill(page, second); const large = 'queue upload bytes\n'.repeat(16000); await file(page, 'queued-original.txt', large);
  const network = await context.newCDPSession(page); await network.send('Network.enable');
  await network.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: 128 * 1024 });
  try {
    const uploading = page.waitForRequest(request => request.method() === 'PUT' && new URL(request.url()).pathname.includes('/message-queue/uploads/'));
    await page.getByRole('button', { name: 'Send', exact: true }).click(); await uploading;
    assert.equal(await message(page).isEditable(), true); await fill(page, draft);
    await page.getByText('Uploading and saving…', { exact: true }).waitFor();
    const two = await wait(() => queue(session), value => value.entries.length === 2, 'file queued entry');
    assert.deepEqual(two.entries.map(entry => entry.text), [first, second]); await checkFiles(session, two.entries[1], { 'queued-original.txt': large });
  } finally {
    await network.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); await network.detach();
  }
  assert.equal(await row(page, 1).evaluate(element => element.getBoundingClientRect().height <= 40), true, 'Multiline queued text expanded its row.');
  const editFirst = page.getByRole('button', { name: 'Edit queued message 1', exact: true });
  const editIsPainted = () => editFirst.evaluate(element => {
    for (let current = element; current; current = current.parentElement) if (Number(getComputedStyle(current).opacity) === 0) return false;
    return true;
  });
  await message(page).focus(); await page.mouse.move(0, 0);
  assert.equal(await editIsPainted(), false, 'Queue edit action must stay hidden until hover or focus.');
  await row(page, 1).hover(); assert.equal(await editIsPainted(), true, 'Hover must reveal queue actions.');
  await page.mouse.move(0, 0); await editFirst.focus(); assert.equal(await editIsPainted(), true, 'Keyboard focus must reveal queue actions.');
  await message(page).focus();
  await expectText(page, draft); await file(page, 'stashed-local.txt', 'ordinary draft blob');
  await rowAction(page, 2, 'Edit queued message 2'); await expectText(page, second);
  const edited = `Edited second ${token}`;
  await fill(page, edited); await file(page, 'edit-local.txt', 'edit buffer blob');
  await localFiles(page, { 'stashed-local.txt': 'ordinary draft blob', 'edit-local.txt': 'edit buffer blob' });
  await wait(() => queue(session), value => value.entries[1]?.edit?.text === edited, 'server edit autosave');
  await open(page, session); await row(page, 2).getByRole('button', { name: 'Recover edit', exact: true }).click(); await expectText(page, edited);
  assert.ok((await page.getByLabel('Attachments to send', { exact: true }).textContent()).includes('edit-local.txt'));
  await page.getByRole('button', { name: 'Cancel edit', exact: true }).click(); await expectText(page, draft);
  assert.ok((await page.getByLabel('Attachments to send', { exact: true }).textContent()).includes('stashed-local.txt'));
  assert.equal((await queue(session)).entries[1].text, second);
  await rowAction(page, 2, 'Edit queued message 2'); await expectText(page, second);
  await fill(page, edited); await file(page, 'edit-saved.txt', 'saved edit bytes');
  await page.getByRole('button', { name: 'Save queued message', exact: true }).click(); await expectText(page, draft);
  const saved = await wait(() => queue(session), value => value.entries[1]?.text === edited && value.entries[1]?.state === 'queued', 'saved edit');
  await checkFiles(session, saved.entries[1], { 'queued-original.txt': large, 'edit-saved.txt': 'saved edit bytes' });
  const handle = await page.getByRole('button', { name: 'Reorder queued message 2', exact: true }).boundingBox();
  const target = await row(page, 1).boundingBox(); assert.ok(handle && target, 'Queue reorder handle and target must be visible.');
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, target.y + target.height / 2, { steps: 8 }); await page.mouse.up();
  await wait(() => queue(session), value => value.entries[0]?.id === saved.entries[1].id, 'reorder');
  await rowAction(page, 2, 'Delete queued message 2');
  await wait(() => queue(session), value => value.entries.length === 1 && value.entries[0].text === edited, 'delete one queued row');
  await page.getByRole('button', { name: 'Send', exact: true }).click(); await expectText(page, '');
  await wait(() => queue(session), value => value.entries.length === 2, 'stashed draft queued with its blob');
  const secondTab = await context.newPage(); watch(secondTab); await open(secondTab, session);
  await rowAction(page, 1, 'Edit queued message 1'); await expectText(page, edited);
  await fill(page, 'First tab edit'); await file(page, 'first-tab.txt', 'first tab bytes');
  await rowAction(secondTab, 2, 'Edit queued message 2'); await expectText(secondTab, draft);
  await fill(secondTab, 'Second tab edit'); await file(secondTab, 'second-tab.txt', 'second tab bytes');
  await localFiles(page, { 'first-tab.txt': 'first tab bytes', 'second-tab.txt': 'second tab bytes' });
  await wait(() => queue(session), value => value.entries[0]?.edit?.text === 'First tab edit' && value.entries[1]?.edit?.text === 'Second tab edit', 'independent row autosaves');
  await open(page, session); await row(page, 1).getByRole('button', { name: 'Recover edit', exact: true }).click(); await expectText(page, 'First tab edit');
  await open(secondTab, session); await row(secondTab, 2).getByRole('button', { name: 'Recover edit', exact: true }).click(); await expectText(secondTab, 'Second tab edit');
  assert.ok((await page.getByLabel('Attachments to send', { exact: true }).textContent()).includes('first-tab.txt'));
  assert.ok((await secondTab.getByLabel('Attachments to send', { exact: true }).textContent()).includes('second-tab.txt'));
  await page.getByRole('button', { name: 'Save queued message', exact: true }).click();
  await wait(() => queue(session), value => value.entries[0]?.state === 'queued' && value.entries[1]?.state === 'editing', 'saving one row preserves the other editor');
  await expectText(secondTab, 'Second tab edit');
  await secondTab.getByRole('button', { name: 'Save queued message', exact: true }).click();
  const independent = await wait(() => queue(session), value => value.entries.every(entry => entry.state === 'queued'), 'second saved row');
  await checkFiles(session, independent.entries[0], { 'first-tab.txt': 'first tab bytes' });
  await checkFiles(session, independent.entries[1], { 'second-tab.txt': 'second tab bytes', 'stashed-local.txt': 'ordinary draft blob' });
  await secondTab.close();
  await open(page, session); await page.setViewportSize({ width: 360, height: 800 }); await page.emulateMedia({ colorScheme: 'dark' });
  await row(page, 2).waitFor();
  assert.equal(await rows(page).count(), 2);
  assert.equal(await rows(page).evaluateAll(elements => elements.every(element => element.getBoundingClientRect().height <= 40)), true, 'Queued messages must stay compact at 360 px.');
  assert.equal(await page.locator('html').evaluate(element => element.scrollWidth <= innerWidth), true);
  assert.ok((await page.getByRole('region', { name: 'Message queue', exact: true }).textContent()).includes('Queue paused'));
  if (process.env.HOSTY_QUEUE_SCREENSHOT) await page.screenshot({ path: process.env.HOSTY_QUEUE_SCREENSHOT, fullPage: true });

  const background = await createSession('Queue background dispatch acceptance');
  await page.setViewportSize({ width: 1280, height: 900 }); await open(page, background);
  const prompts = [`First controlled worker turn ${token}`, `Second after closed tab ${token}`, `Third FIFO turn ${token}`];
  await fill(page, prompts[0]); await page.getByRole('button', { name: 'Send', exact: true }).click();
  await wait(() => requests.length, value => value === 1, 'first actual Worker Ollama request');
  await fill(page, prompts[1]); await file(page, 'background.txt', 'background attachment bytes'); await page.getByRole('button', { name: 'Send', exact: true }).click(); await expectText(page, '');
  await fill(page, prompts[2]); await page.getByRole('button', { name: 'Send', exact: true }).click();
  await wait(() => queue(background), value => value.entries.length === 2 && value.entries.every(entry => entry.state === 'queued'), 'FIFO behind running turn');
  await page.getByRole('button', { name: 'Pause queue', exact: true }).click(); await wait(() => queue(background), value => value.paused, 'pause running queue');
  await page.getByRole('button', { name: 'Resume queue', exact: true }).click(); await wait(() => queue(background), value => !value.paused, 'resume running queue');
  await page.close(); releaseFirst();
  await wait(() => requests.length, value => value === 3, 'background Worker drained all messages with no open page');
  await wait(() => api('/sessions/' + background.id), value => value.status === 'idle', 'background conversation idle');
  assert.equal((await queue(background)).entries.length, 0);
  for (let index = 0; index < prompts.length; index++) {
    const lastUser = requests[index].messages.filter(message => message.role === 'user').at(-1);
    assert.ok(lastUser?.content.includes(prompts[index]), 'Worker request order changed.');
  }
  assert.ok(requests[1].messages.some(message => message.role === 'user' && message.content.includes('background attachment bytes')));
  const reopened = await context.newPage(); watch(reopened); await open(reopened, background);
  for (const prompt of prompts) await reopened.getByText(prompt, { exact: true }).waitFor();
  await reopened.getByText('Queue fixture answer 3', { exact: true }).waitFor();
  assert.equal(await reopened.getByRole('region', { name: 'Message queue', exact: true }).count(), 0);
  assert.ok(states.has('queued') && states.has('editing') && states.has('sending'), 'Real queue stream did not report queued/editing/sending states.');
  assert.deepEqual(fixtureErrors, []); assert.deepEqual(pageErrors, []);
  console.log('PASS: normal Core password login and app PKCE; real paused FIFO queue, editable composer during upload, server attachment bytes, reload/recover/edit/save/cancel/stash, reorder/delete, independent multi-tab row blobs, 360px dark layout, real queued/editing/sending stream states, and three actual Worker requests in order after closing the last tab (owned deterministic Ollama HTTP fixture; no external inference).');
} finally {
  releaseFirst();
  if (preference) {
    try { const current = await api('/preferences/prompt-suggestions'); if (current.enabled !== preference.enabled) await api('/preferences/prompt-suggestions', 'PUT', { enabled: preference.enabled, revision: current.revision }); } catch { /* Parent fixture cleanup retains the original failure. */ }
  }
  await browser.close(); fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve));
}
