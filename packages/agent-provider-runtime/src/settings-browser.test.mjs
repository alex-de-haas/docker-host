// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { settingsHtml } from './settings.ts';

const sdk = vi.hoisted(() => ({
  appFetch: vi.fn(), appSessionActive: vi.fn(), configureAppActivity: vi.fn(),
  openAppSignIn: vi.fn(), rememberAppGrant: vi.fn(), restoreAppGrant: vi.fn(),
  configureAppContinuity: vi.fn(), activityStop: vi.fn(), continuityStop: vi.fn(),
}));
vi.mock('@hosty-sdk/app/browser-auth', () => ({
  appFetch: sdk.appFetch, appSessionActive: sdk.appSessionActive, configureAppActivity: sdk.configureAppActivity,
  openAppSignIn: sdk.openAppSignIn, rememberAppGrant: sdk.rememberAppGrant, restoreAppGrant: sdk.restoreAppGrant,
}));
vi.mock('@hosty-sdk/app/continuity/browser', () => ({ configureAppContinuity: sdk.configureAppContinuity }));

let stop;
const element = id => document.getElementById(id);
const settle = async () => { for (let turn = 0; turn < 40; turn++) await Promise.resolve(); };
const response = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => value });
const connection = (overrides = {}) => ({ id:'account-1', name:'Personal', kind:'codex', auth:'api-key', revision:'7', available:true, ...overrides });
const pendingLogin = { id:'login-1', connectionId:'account-1', status:'pending', userCode:'ABCD-EFGH', verificationUrl:'https://auth.example/device' };
const namedButton = (name, root = document) => [...root.querySelectorAll('button')].find(node => node.textContent.trim() === name);
const actionTrigger = () => document.querySelector('button[aria-haspopup="menu"]');
function openAction(name) { actionTrigger().click(); namedButton(name,document.querySelector('[role="menu"]')).click(); }
function submit() { element('connection-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})); }

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  sdk.configureAppActivity.mockReturnValue(sdk.activityStop);
  sdk.configureAppContinuity.mockReturnValue(sdk.continuityStop);
  Object.defineProperty(HTMLDialogElement.prototype,'showModal',{configurable:true,value() { this.open = true; }});
  Object.defineProperty(HTMLDialogElement.prototype,'close',{configurable:true,value() { this.open = false; }});
  vi.stubGlobal('matchMedia',vi.fn(() => ({matches:false,addEventListener:vi.fn(),removeEventListener:vi.fn()})));
  sessionStorage.clear();
  history.replaceState({},'', '/settings');
});
afterEach(() => {
  stop?.(); stop = undefined;
  vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals();
  document.body.replaceChildren();
});

async function page({ kind = 'codex', connections = [connection()], defaultId = 'account-1', handle } = {}) {
  const parsed = new DOMParser().parseFromString(settingsHtml(kind),'text/html');
  document.head.replaceChildren(...[...parsed.head.children].filter(node => node.tagName !== 'SCRIPT'));
  document.body.replaceWith(document.importNode(parsed.body,true));
  for (const script of document.querySelectorAll('script')) script.remove();
  let inventory = { defaultId, connections };
  const requests = [];
  sdk.appFetch.mockImplementation(async (path, options = {}) => {
    const request = { path, method:options.method ?? 'GET', ...(options.body ? { body:JSON.parse(options.body) } : {}) };
    requests.push(request);
    const result = await handle?.(request);
    if (result !== undefined) return result;
    if (path === '/api/auth/session') return response({
      status:'active', activeUntil:'2026-11-13T12:00:00Z', activityRequired:true,
      recovery:{appId:'independent.provider',corePublicOrigin:'https://core.example',appAuthProtocol:2},
      continuity:{grantId:'grant-1'},
    });
    if (path === '/api/settings/connections' && request.method === 'GET') return response(inventory);
    if (/^\/api\/settings\/connections\/[^/]+\/usage\?refresh=true$/.test(path)) return response({state:'unavailable',rows:[],observedAt:null,connectionRevision:String(inventory.connections.find(value=>path.includes('/'+value.id+'/'))?.revision)});
    throw new Error(`Unexpected test request: ${request.method} ${path}`);
  });
  ({stopProviderSettings:stop} = await import('./settings-browser.mjs'));
  await settle();
  expect(element('connections').getAttribute('aria-busy')).toBe('false');
  return { requests, setInventory: value => { inventory = value; } };
}

it('opens Add as a modal focused on the name and preserves SDK activity and continuity setup', async () => {
  await page();
  element('add-provider').focus(); element('add-provider').click();
  expect(element('editor').open).toBe(true);
  expect(document.activeElement).toBe(element('name'));
  expect(element('secret').value).toBe('');
  expect(sdk.restoreAppGrant).toHaveBeenCalledOnce();
  expect(sdk.configureAppActivity).toHaveBeenCalledWith(expect.objectContaining({appAuthProtocol:2,exchangeCode:expect.any(Function),validateSession:expect.any(Function)}));
  expect(sdk.configureAppContinuity).toHaveBeenCalledWith(expect.objectContaining({coreOrigin:'https://core.example',authority:{grantId:'grant-1'},probe:expect.any(Function)}));
  stop(); stop = undefined;
  expect(sdk.activityStop).toHaveBeenCalledOnce(); expect(sdk.continuityStop).toHaveBeenCalledOnce();
});

it('edits with a blank credential and immutable auth, sending the exact revision without a replacement secret', async () => {
  const f = await page({handle: request => request.method === 'PUT' ? response({connections:[connection({name:'Renamed',revision:'8'})],saved:{id:'account-1',revision:'8'}}) : undefined});
  openAction('Edit');
  expect(element('editor').open).toBe(true);
  expect(element('name').value).toBe('Personal');
  expect(element('secret').value).toBe('');
  expect(element('secret').required).toBe(false);
  expect(element('auth').value).toBe('api-key'); expect(element('auth').disabled).toBe(true);
  element('name').value = 'Renamed'; submit(); await settle();
  expect(f.requests.find(request => request.method === 'PUT')).toEqual({
    path:'/api/settings/connections/account-1', method:'PUT', body:{name:'Renamed',auth:'api-key',expectedRevision:'7'},
  });
  expect(element('editor').open).toBe(false);
  expect(document.activeElement).toBe(element('add-provider'));
});

it('starts ChatGPT login with the saved acknowledgement from the inventory response', async () => {
  const f = await page({connections:[],handle:request => {
    if (request.path === '/api/settings/connections' && request.method === 'POST') {
      f.setInventory({defaultId:'new-account',connections:[connection({id:'new-account',name:'New ChatGPT',auth:'chatgpt',revision:'12'})]});
      return response({defaultId:'new-account',connections:[connection({id:'new-account',auth:'chatgpt',revision:'12'})],saved:{id:'new-account',revision:'12'}});
    }
    if (request.path === '/api/settings/connections/new-account/login') return response({...pendingLogin,connectionId:'new-account'});
  }});
  element('add-provider').click(); element('name').value = 'New ChatGPT'; submit(); await settle();
  expect(f.requests.find(request => request.path.endsWith('/login'))).toEqual({
    path:'/api/settings/connections/new-account/login',method:'POST',body:{expectedRevision:'12'},
  });
  expect(f.requests.some(request => request.path.includes('undefined'))).toBe(false);
  expect(element('login-dialog').open).toBe(true);
  expect(element('login-code').textContent).toBe('ABCD-EFGH');
});

it('keeps a failed save and its credential draft open until Cancel clears it and restores focus', async () => {
  await page({kind:'claude',connections:[],handle:request => request.method === 'POST' ? response({message:'Connection changed; refresh and retry.'},409) : undefined});
  const add = element('add-provider'); add.focus(); add.click();
  element('name').value = 'Work'; element('secret').value = 'synthetic-draft'; submit(); await settle();
  expect(element('editor').open).toBe(true);
  expect(element('secret').value).toBe('synthetic-draft');
  expect(element('form-error').hidden).toBe(false);
  expect(element('form-error').textContent).toContain('Connection changed');
  element('clear').click();
  expect(element('editor').open).toBe(false); expect(element('secret').value).toBe('');
  expect(document.activeElement).toBe(add);
});

it('opens the menu on its first enabled action and restores its trigger on Escape', async () => {
  await page({connections:[connection({available:false})],defaultId:null});
  const trigger = actionTrigger(); trigger.focus();
  trigger.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));
  const menu = document.querySelector('[role="menu"]');
  expect(namedButton('Set default',menu).disabled).toBe(true);
  expect(menu.hidden).toBe(false); expect(document.activeElement).toBe(namedButton('Edit',menu));
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
  expect(menu.hidden).toBe(true); expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(trigger);
});

it('keeps a connection without deleting it, then removes only after confirmation with its exact revision', async () => {
  const f = await page({handle:request => {
    if (request.method === 'DELETE') { f.setInventory({defaultId:null,connections:[]}); return response({}); }
  }});
  openAction('Remove'); namedButton('Keep provider').click(); await settle();
  expect(f.requests.some(request => request.method === 'DELETE')).toBe(false);
  expect(document.querySelector('.remove-confirmation')).toBeNull();
  expect(document.activeElement).toBe(actionTrigger());
  openAction('Remove'); namedButton('Remove provider').click(); await settle();
  expect(f.requests.filter(request => request.method === 'DELETE')).toEqual([
    {path:'/api/settings/connections/account-1',method:'DELETE',body:{expectedRevision:'7'}},
  ]);
  expect(document.querySelector('.connection')).toBeNull();
});

it('ignores a polling response that arrives after cancellation without reopening or scheduling another poll', async () => {
  vi.useFakeTimers();
  let resolvePoll;
  const late = new Promise(resolve => { resolvePoll = resolve; });
  const f = await page({connections:[connection({auth:'chatgpt',available:false})],handle:request => {
    if (request.path.endsWith('/login') && request.method === 'POST') return response(pendingLogin);
    if (request.path === '/api/settings/logins/login-1') return request.method === 'GET' ? late : response({status:'cancelled'});
  }});
  openAction('Sign in with ChatGPT'); await settle();
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.requests.filter(request => request.path === '/api/settings/logins/login-1' && request.method === 'GET')).toHaveLength(1);
  element('login-close').click(); await settle();
  expect(element('login-dialog').open).toBe(false);
  const schedule = vi.spyOn(globalThis,'setTimeout');
  resolvePoll(response(pendingLogin)); await settle();
  expect(element('login-dialog').open).toBe(false); expect(schedule).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(6000);
  expect(f.requests.filter(request => request.path === '/api/settings/logins/login-1' && request.method === 'GET')).toHaveLength(1);
});

it.each([true,false])('restores login focus after load replaces the row (connection remains: %s)', async remains => {
  const f = await page({connections:[connection({auth:'chatgpt',available:false})],handle:request => {
    if (request.path.endsWith('/login') && request.method === 'POST') return response(pendingLogin);
    if (request.path === '/api/settings/logins/login-1' && request.method === 'DELETE') {
      f.setInventory({defaultId:remains?'account-1':null,connections:remains?[connection({auth:'chatgpt'})]:[]});
      return response({status:'cancelled'});
    }
  }});
  const original = actionTrigger(); openAction('Sign in with ChatGPT'); await settle();
  expect(element('login-dialog').open).toBe(true);
  element('login-close').click(); await settle();
  expect(element('login-dialog').open).toBe(false); expect(original.isConnected).toBe(false);
  expect(document.activeElement).toBe(remains?actionTrigger():element('add-provider'));
});

const limits = () => document.querySelector('[data-slot="provider-usage"]');
const usageValue = (overrides = {}) => {
  const observedAt = new Date().toISOString();
  return {state:'available',connectionRevision:'7',observedAt,rows:[
    {id:'short',group:'codex:account',kind:'quota',label:'Account · 5 hours',unit:'percent',used:20,remaining:80,limit:100,observedAt,resetsAt:new Date(Date.now()+3600000).toISOString()},
    {id:'weekly',group:'codex:account',kind:'quota',label:'Account · 7 days',unit:'percent',used:65,remaining:35,limit:100,observedAt,resetsAt:new Date(Date.now()+86400000).toISOString()},
  ],...overrides};
};
const isUsage = request => request.path.includes('/usage?refresh=true');

it('loads the old compact ring before a chat and opens all factual quota/credit details with Escape focus restoration', async () => {
  const value=usageValue();value.rows.push({id:'credits',group:'codex:credits',kind:'credits',label:'Extra credits',unit:'credits',remaining:0,observedAt:value.observedAt});
  const f=await page({handle:request=>isUsage(request)?response(value):undefined});
  expect(f.requests.filter(isUsage)).toHaveLength(1);
  expect(limits().textContent).toBe('35% left');expect(limits().querySelector('[role="meter"]').getAttribute('aria-valuenow')).toBe('35');
  expect(limits().querySelector('.usage-ring-icon svg')).not.toBeNull();
  const trigger=limits();trigger.focus();trigger.click();await settle();
  expect(element('usage-dialog').open).toBe(true);expect(element('usage-content').textContent).toContain('80% remaining');
  expect(element('usage-content').textContent).toContain('35% remaining');expect(element('usage-content').textContent).toContain('0 credits remaining');
  expect(element('usage-content').querySelectorAll('progress')).toHaveLength(2);expect(element('usage-content').querySelectorAll('time')).toHaveLength(5);
  expect(document.activeElement.getAttribute('aria-label')).toBe('Close limits');
  element('usage-dialog').dispatchEvent(new Event('cancel',{cancelable:true}));
  expect(element('usage-dialog').open).toBe(false);expect(document.activeElement).toBe(trigger);
});

it('retains last-known rows after a failed refresh without inventing a remaining percentage', async () => {
  let fail=false;const f=await page({handle:request=>isUsage(request)?fail?response({message:'Account limits unavailable'},503):response(usageValue()):undefined});
  limits().click();await settle();fail=true;element('usage-refresh').click();await settle();
  expect(element('usage-content').textContent).toContain('Account limits unavailable');
  expect(element('usage-content').textContent).toContain('Last known values');expect(element('usage-content').textContent).toContain('35% remaining');
  expect(limits().textContent).toBe('? left');expect(limits().querySelector('[role="meter"]')).toBeNull();
  expect(f.requests.filter(isUsage)).toHaveLength(3);
});

it('does not replace an open credential/name draft when a background limits read completes', async () => {
  let complete;const pending=new Promise(resolve=>{complete=resolve;});
  await page({handle:request=>isUsage(request)?pending:undefined});
  openAction('Edit');element('name').value='Unsent connection name';element('secret').value='synthetic-unsaved-draft';
  complete(response(usageValue()));await settle();
  expect(element('editor').open).toBe(true);expect(element('name').value).toBe('Unsent connection name');
  expect(element('secret').value).toBe('synthetic-unsaved-draft');expect(limits().textContent).toBe('35% left');
});

it.each(['unsupported','not_applicable'])('hides the compact indicator for %s without claiming unlimited quota', async state => {
  await page({handle:request=>isUsage(request)?response(usageValue({state,rows:[]})):undefined});
  expect(limits().hidden).toBe(true);expect(document.querySelector('[role="meter"]')).toBeNull();
  expect(element('connections').textContent).not.toContain('Unlimited');expect(actionTrigger()).not.toBeNull();
});

it.each([{state:'unavailable',rows:[]},{partial:true},{invalidated:true},{stale:true}])('keeps an incomplete observation unknown: %j', async override => {
  await page({handle:request=>isUsage(request)?response(usageValue(override)):undefined});
  expect(limits().hidden).toBe(false);expect(limits().textContent).toBe('? left');expect(limits().querySelector('[role="meter"]')).toBeNull();
});

it('coalesces opening/refreshing in-flight limits and bounds account requests to two', async () => {
  const complete=[];const f=await page({connections:[connection(),connection({id:'account-2'}),connection({id:'account-3'})],handle:request=>isUsage(request)?new Promise(resolve=>complete.push(resolve)):undefined});
  expect(f.requests.filter(isUsage)).toHaveLength(2);limits().click();await settle();
  expect(element('usage-refresh').disabled).toBe(true);element('usage-refresh').click();await settle();
  expect(f.requests.filter(isUsage)).toHaveLength(2);
  complete[0](response(usageValue()));await settle();expect(f.requests.filter(isUsage)).toHaveLength(3);
  complete[1](response(usageValue()));complete[2](response(usageValue()));await settle();
  expect(element('usage-refresh').disabled).toBe(false);
});

it('rejects a delayed observation after the account revision changes', async () => {
  let complete,reads=0;const pending=new Promise(resolve=>{complete=resolve;});
  const f=await page({handle:request=>isUsage(request)?++reads===1?pending:response(usageValue({connectionRevision:'8',rows:[{...usageValue().rows[0],remaining:88,used:12}]})):undefined});
  f.setInventory({defaultId:'account-1',connections:[connection({revision:'8'})]});element('refresh').click();await settle();
  expect(limits().textContent).toBe('88% left');complete(response(usageValue()));await settle();
  expect(limits().textContent).toBe('88% left');expect(element('usage-dialog')).toBeNull();
});

it('does not reinstall a removed row or reopen limits when its delayed request resolves', async () => {
  let complete;const pending=new Promise(resolve=>{complete=resolve;});
  const f=await page({handle:request=>isUsage(request)?pending:undefined});limits().click();await settle();
  f.setInventory({defaultId:null,connections:[]});element('refresh').click();await settle();
  expect(element('usage-dialog').open).toBe(false);expect(limits()).toBeNull();
  complete(response(usageValue()));await settle();expect(limits()).toBeNull();expect(element('usage-dialog').open).toBe(false);
});

it('never presents limits for a response naming a different account revision', async () => {
  await page({handle:request=>isUsage(request)?response(usageValue({connectionRevision:'8'})):undefined});
  expect(limits().textContent).toBe('? left');limits().click();await settle();
  expect(element('usage-content').textContent).toContain('This connection changed');expect(element('usage-content').textContent).not.toContain('35%');
});

it('expires the displayed meter with a local clock without periodically requesting provider limits', async () => {
  vi.useFakeTimers();const value=usageValue();const f=await page({handle:request=>isUsage(request)?response(value):undefined});
  expect(limits().textContent).toBe('35% left');await vi.advanceTimersByTimeAsync(180000);
  expect(limits().textContent).toBe('? left');expect(limits().querySelector('[role="meter"]')).toBeNull();expect(f.requests.filter(isUsage)).toHaveLength(1);
});

it('renders long account/limit labels as literal text and keeps the details refresh focus stable', async () => {
  const name='Long account '+ 'name '.repeat(30),value=usageValue();value.rows[0].label='<script>untrusted label</script>'+' window '.repeat(30);
  await page({connections:[connection({name})],handle:request=>isUsage(request)?response(value):undefined});
  limits().click();await settle();expect(element('usage-title').textContent).toBe('Provider limits · '+name);
  expect(element('usage-content').textContent).toContain('<script>untrusted label</script>');expect(element('usage-content').querySelector('script')).toBeNull();
  const refresh=element('usage-refresh');refresh.focus();refresh.click();await settle();expect(document.activeElement).toBe(refresh);
});

it('updates renamed account labels while retaining same-revision quota observations', async () => {
  const f=await page({handle:request=>isUsage(request)?response(usageValue()):undefined});
  f.setInventory({defaultId:'account-1',connections:[connection({name:'Renamed account'})]});element('refresh').click();await settle();
  expect(limits().getAttribute('aria-label')).toContain('Renamed account');limits().click();await settle();
  expect(element('usage-title').textContent).toBe('Provider limits · Renamed account');expect(limits().textContent).toBe('35% left');
});
