// Normal Core login and real Harness data; only context SSE is a controlled UI fixture.
// This is composer acceptance, not evidence of live provider inference. Credentials arrive on stdin.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
const { chromium } = await import(process.env.HOSTY_CONTEXT_PLAYWRIGHT_MODULE || 'playwright');
let input = ''; for await (const chunk of process.stdin) input += chunk;
const config = JSON.parse(input); input = '';
const browser = await chromium.launch({ headless: true, channel: process.env.HOSTY_CONTEXT_BROWSER_CHANNEL || 'chrome' });
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
  const response = await page.request.post(config.harness + '/api/sessions', { headers: { Origin: config.harness }, data: { title: 'Codex context browser acceptance' } });
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
  await open('embedded');
  const sources = {version:1,method:'local-estimate',estimator:'o200k-base-chunks-1024-v1',instructions:[{source:'runtime',tokens:80},{source:'operator',tokens:120}],omittedInstructions:0,catalog:{state:'complete',observedAt:new Date().toISOString()}};
  const usage = {usedTokens:123,maxTokens:1000,estimated:true,observedAt:new Date().toISOString(),sources,
    mcp:{version:1,method:'local-estimate',estimator:sources.estimator,omittedTools:0,tools:[{server:'fixture-server',name:'inspect_original',tokens:42,inclusion:'unknown'}]}};
  const emit = (usage, seq) => socket.send(`data: ${JSON.stringify({type:'context_usage',seq,ts:new Date().toISOString(),usage})}\n\n`);
  emit(usage, 1);
  const trigger=page.getByRole('button',{name:/Context usage:.*View local context estimates/});
  await trigger.waitFor(); assert.ok((await trigger.getAttribute('aria-label')).includes('12.3%'));
  await trigger.focus(); await trigger.press('Enter');
  const dialog=page.getByRole('dialog'); await dialog.waitFor();
  assert.ok((await dialog.textContent()).includes('o200k_base BPE'));
  assert.ok((await dialog.textContent()).includes('Operator instructions'));
  await dialog.locator('summary').click(); assert.ok((await dialog.textContent()).includes('inspect_original'));
  assert.ok((await dialog.textContent()).includes('inclusion unknown'));
  await page.setViewportSize({width:390,height:844}); await page.emulateMedia({colorScheme:'dark'});
  assert.ok(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth));
  await page.keyboard.press('Escape'); await dialog.waitFor({state:'hidden'});
  assert.equal(await trigger.evaluate(node=>node===document.activeElement),true);
  emit(null,2); await page.getByRole('button',{name:/Context usage: Not available/}).waitFor();
  emit({...usage,mcp:undefined,sources:{...sources,catalog:{...sources.catalog,state:'unavailable'}}},3);
  await trigger.click(); await dialog.waitFor(); assert.ok((await dialog.textContent()).includes('Catalog unavailable'));
  assert.equal(messages,0); assert.deepEqual(errors,[]);
  console.log('PASS: normal Core browser login, Codex local estimates, native meter, keyboard focus, mobile dark layout, unavailable catalog and compaction (controlled SSE, no inference).');
} finally { await browser.close(); }
