// Normal Core login and real Harness data; context and tool-event SSE use controlled UI fixtures.
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
  let socket, connected, streamGeneration = 0;
  await page.routeWebSocket('**/api/event-stream', route => {
    const generation = streamGeneration;
    const server = route.connectToServer();
    server.onMessage(message => {
      route.send(message);
      if (generation === streamGeneration && String(message).includes('"type":"session_status"')) { socket = route; connected?.(); }
    });
  });
  const open = async (mode, sessionId = session.id, reload = false) => {
    streamGeneration++; socket = undefined;
    let timer;
    const ready = new Promise((resolve, reject) => { connected = resolve; timer = setTimeout(() => reject(new Error('Conversation stream did not connect')), 30000); });
    try {
      if (reload) await page.reload();
      else await page.goto(`${config.harness}/${mode === 'full-page' ? 'chats' : 'assistant'}/?session=${sessionId}&hosty_launch=${mode}`);
      await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor(); await ready;
    } finally { clearTimeout(timer); }
  };
  await open('embedded');
  const trigger=page.getByRole('button',{name:/Context usage:.*View recorded MCP calls and context detail/});
  const dialog=page.getByRole('dialog');
  const activity=dialog.locator('[data-slot="mcp-activity"]');
  await trigger.click(); await dialog.waitFor();
  await activity.getByText('0 calls',{exact:true}).waitFor();
  assert.ok((await activity.textContent()).includes('No MCP calls are recorded in the loaded transcript'));
  assert.equal(await dialog.locator('[data-slot="mcp-definitions"]').count(),0);
  await dialog.getByRole('button',{name:'Close',exact:true}).click(); await dialog.waitFor({state:'hidden'});
  const sources = {version:1,method:'local-estimate',estimator:'o200k-base-chunks-1024-v1',instructions:[{source:'runtime',tokens:80},{source:'operator',tokens:120}],omittedInstructions:0,catalog:{state:'complete',observedAt:new Date().toISOString()}};
  const usage = {usedTokens:123,maxTokens:1000,estimated:true,observedAt:new Date().toISOString(),sources,
    mcp:{version:1,method:'local-estimate',estimator:sources.estimator,omittedTools:0,tools:[{server:'fixture-server',name:'inspect_original',tokens:42,inclusion:'unknown'}]}};
  const event = (type, seq, fields = {}) => socket.send(`data: ${JSON.stringify({type,seq,ts:new Date().toISOString(),...fields})}\n\n`);
  const emit = (usage, seq) => event('context_usage', seq, {usage});
  const recordedCalls = () => {
    const call = {toolUseId:'fixture-list',toolName:'mcp__platform-tools__list',input:{},mcp:{server:'platform-tools',tool:'list'}};
    event('tool_use',101,call); event('tool_use',101,call);
    event('tool_result',102,{toolUseId:'fixture-list',status:'completed',output:'Fixture result'});
    event('tool_use',103,{toolUseId:'fixture-read',toolName:'mcp__platform-tools__read',input:{},mcp:{server:'platform-tools',tool:'read'}});
    event('tool_result',104,{toolUseId:'fixture-read',status:'failed',output:'Fixture refusal'});
    event('tool_use',105,{toolUseId:'fixture-wrapper',toolName:'functions.exec',input:'await tools.mcp__platform_tools__nested({})'});
    event('tool_result',106,{toolUseId:'fixture-wrapper',status:'completed',output:''});
    event('tool_use',107,{toolName:'mcp__legacy-server__inspect',input:{}});
    event('tool_use',108,{toolUseId:'fixture-cancelled',toolName:'mcp__platform-tools__cancelled',input:{},mcp:{server:'platform-tools',tool:'cancelled'}});
    event('tool_result',109,{toolUseId:'fixture-cancelled',status:'cancelled',output:''});
  };
  recordedCalls(); emit(usage,110);
  await page.getByRole('button',{name:/Context usage:.*12\.3%.*View recorded MCP calls/}).waitFor();
  assert.ok((await trigger.getAttribute('aria-label')).includes('12.3%'));
  await trigger.focus(); await trigger.press('Enter');
  await dialog.waitFor();
  await activity.getByText('4 calls',{exact:true}).waitFor();
  const platform = activity.locator('[data-slot="mcp-activity-server"][data-server="platform-tools"]');
  await platform.locator('summary').click();
  assert.ok((await platform.textContent()).includes('Completed: 1'));
  assert.ok((await platform.textContent()).includes('Failed/refused: 1'));
  assert.ok((await platform.textContent()).includes('Cancelled: 1'));
  const legacy=activity.locator('[data-slot="mcp-activity-server"][data-server="legacy-server"]');
  await legacy.locator('summary').click();
  await legacy.getByText('Unknown outcome: 1',{exact:true}).waitFor();
  assert.ok(!(await activity.textContent()).includes('nested'));
  assert.ok((await dialog.textContent()).includes('Schema loading · unknown for Codex'));
  assert.ok((await dialog.textContent()).includes('Actual MCP token usage · unavailable for Codex'));
  const definitions = dialog.locator('[data-slot="mcp-definitions"]');
  assert.equal(await definitions.getAttribute('open'),null);
  await definitions.locator(':scope > summary').click();
  assert.ok((await dialog.textContent()).includes('o200k_base BPE'));
  assert.ok((await dialog.textContent()).includes('Operator instructions'));
  await definitions.locator(':scope > div > details > summary').click(); assert.ok((await dialog.textContent()).includes('inspect_original'));
  assert.ok((await dialog.textContent()).includes('inclusion unknown'));
  await page.setViewportSize({width:390,height:844}); await page.emulateMedia({colorScheme:'dark'});
  assert.ok(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth));
  await definitions.locator(':scope > summary').click();
  await dialog.locator('[data-slot="dialog-body"]').evaluate(node=>{node.scrollTop=0;});
  if (process.env.HOSTY_CONTEXT_SCREENSHOT) await dialog.screenshot({path:process.env.HOSTY_CONTEXT_SCREENSHOT});
  await page.keyboard.press('Escape'); await dialog.waitFor({state:'hidden'});
  assert.equal(await trigger.evaluate(node=>node===document.activeElement),true);
  emit(null,111); await page.getByRole('button',{name:/Context usage: Not available/}).waitFor();
  await trigger.click(); await dialog.waitFor();
  assert.ok((await activity.textContent()).includes('4 calls'));
  assert.equal(await dialog.locator('[data-slot="mcp-definitions"]').count(),0);
  await dialog.getByRole('button',{name:'Close',exact:true}).click(); await dialog.waitFor({state:'hidden'});
  emit({...usage,mcp:undefined,sources:{...sources,catalog:{...sources.catalog,state:'unavailable'}}},112);
  await page.getByRole('button',{name:/Context usage:.*12\.3%.*View recorded MCP calls/}).waitFor();
  await trigger.click(); await dialog.waitFor();
  await dialog.locator('[data-slot="mcp-definitions"] > summary').click();
  assert.ok((await dialog.textContent()).includes('Catalog unavailable'));
  await dialog.getByRole('button',{name:'Close',exact:true}).click(); await dialog.waitFor({state:'hidden'});
  // The injected frames are client-only. Reload clears them; replay the same records as a
  // controlled reconnect fixture rather than claiming these events reached the backend journal.
  await open('embedded',session.id,true);
  await trigger.click(); await dialog.waitFor();
  await activity.getByText('0 calls',{exact:true}).waitFor();
  await dialog.getByRole('button',{name:'Close',exact:true}).click(); await dialog.waitFor({state:'hidden'});
  recordedCalls(); emit(usage,110);
  await page.getByRole('button',{name:/Context usage:.*12\.3%.*View recorded MCP calls/}).waitFor();
  await trigger.click(); await dialog.waitFor();
  await activity.getByText('4 calls',{exact:true}).waitFor();
  await dialog.getByRole('button',{name:'Close',exact:true}).click(); await dialog.waitFor({state:'hidden'});
  const otherResponse=await page.request.post(config.harness+'/api/sessions',{headers:{Origin:config.harness},data:{title:'Isolated MCP browser acceptance'}});
  assert.equal(otherResponse.status(),200); const other=await otherResponse.json();
  assert.notEqual(other.id,session.id); assert.equal(other.createdBy,owner);
  await open('embedded',other.id);
  await trigger.click(); await dialog.waitFor();
  await activity.getByText('0 calls',{exact:true}).waitFor();
  assert.equal(await activity.locator('[data-slot="mcp-activity-server"]').count(),0);
  assert.equal(await dialog.locator('[data-slot="mcp-definitions"]').count(),0);
  await dialog.getByRole('button',{name:'Close',exact:true}).click(); await dialog.waitFor({state:'hidden'});
  await page.setViewportSize({width:1280,height:900}); await open('full-page');
  recordedCalls(); emit(usage,110);
  await page.getByRole('button',{name:/Context usage:.*12\.3%.*View recorded MCP calls/}).waitFor();
  await trigger.click(); await dialog.waitFor();
  await activity.getByText('4 calls',{exact:true}).waitFor();
  assert.equal(await dialog.locator('[data-slot="mcp-definitions"]').getAttribute('open'),null);
  assert.equal(messages,0); assert.deepEqual(errors,[]);
  console.log('PASS: normal Core browser login, recorded MCP calls and outcomes, duplicate replay, cancelled/unknown outcomes, collapsed catalog, native meter, embedded/full-page composer modes, keyboard focus, mobile dark layout, unavailable catalog, compaction, actual reload with controlled replay and conversation isolation (controlled SSE, no inference).');
} catch (error) {
  console.error('Context browser state:', {
    dialogs: await page.getByRole('dialog').count(),
    meters: await page.locator('[data-slot="context-usage"]').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('aria-label'))),
  });
  throw error;
} finally { await browser.close(); }
