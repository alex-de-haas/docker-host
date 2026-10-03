// Core-owned account UI. Untrusted API values enter the DOM only through textContent/value.
const content = document.querySelector('#content');
const error = document.querySelector('#error');
const notice = document.querySelector('#notice');
const id = encodeURIComponent;
let mutationQueue = Promise.resolve();
let deviceTimer;

function element(tag, text, parent = content) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  parent?.append(node);
  return node;
}
function status(node, message = '') { node.textContent = message; node.hidden = !message; }
async function read(path, init = {}) {
  const response = await fetch(path, { ...init, credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
  if (response.status === 401) {
    location.assign('/login?returnTo=' + id(location.pathname + location.search));
    throw new Error('Please sign in again.');
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || body.code || `Core returned ${response.status}.`);
  return body;
}
function mutate(path, body, method = 'POST') {
  const result = mutationQueue.then(async () => {
    const csrf = await read('/api/auth/csrf');
    return read(path, { method, headers: { 'Content-Type': 'application/json', 'X-Hosty-CSRF': csrf.token },
      body: body === undefined ? undefined : JSON.stringify(body) });
  });
  mutationQueue = result.catch(() => {});
  return result;
}
async function run(action, control) {
  status(error); status(notice);
  if (control) control.disabled = true;
  try { await action(); } catch (cause) { status(error, cause.message); }
  finally { if (control) control.disabled = false; }
}
function button(parent, title, action) {
  const node = element('button', title, parent); node.type = 'button';
  node.onclick = () => run(action, node); return node;
}
function input(parent, label, value = '', type = 'text') {
  const wrapper = element('label', label, parent);
  const node = element('input', undefined, wrapper); node.type = type; node.value = value; return node;
}
function select(parent, label, choices) {
  const wrapper = element('label', label, parent);
  const node = element('select', undefined, wrapper);
  for (const [value, label] of choices) { const option = element('option', label, node); option.value = value; }
  return node;
}
function form(parent, title, submit) {
  const node = element('form', undefined, parent); element('h2', title, node);
  node.onsubmit = event => { event.preventDefault(); void run(() => submit(node), node.querySelector('[type=submit]')); };
  return node;
}
function submit(parent, label) { const b = element('button', label, parent); b.type = 'submit'; b.className = 'primary'; }
function section(title) { const node = element('section'); element('h2', title, node); return node; }
function row(parent, title, description) {
  const node = element('div', undefined, parent); node.className = 'row';
  element('strong', title, node); if (description) element('p', description, node); return node;
}
function safeExternalLink(parent, text, value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Unexpected authorization address.');
  const link = element('a', text, parent); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
}

async function tokensPage() {
  const [session, listing, pending, roster] = await Promise.all([
    read('/api/auth/session'), read('/api/auth/credentials'), read('/api/auth/device/requests'), read('/api/apps'),
  ]);
  content.replaceChildren();
  const requests = section('Authorize a device');
  element('p', 'Approve only a code displayed by a device you are connecting. The credential has your current host role.', requests);
  const deviceForm = form(requests, 'Device code', async () => {
    if (!confirm(`Authorize device code ${code.value}? This device will act with your host role.`)) return;
    await mutate('/api/auth/device/requests/approve', { userCode: code.value }); await tokensPage();
  });
  const code = input(deviceForm, 'Code shown on your device'); code.required = true; submit(deviceForm, 'Authorize device');
  for (const request of pending.requests) {
    const item = row(requests, request.label || 'Device', `${request.userCode} · expires ${`${request.expiresInSeconds} seconds from now`}`);
    button(item, 'Approve', async () => {
      if (!confirm(`Authorize ${request.label || 'this device'} with code ${request.userCode}?`)) return;
      await mutate('/api/auth/device/requests/approve', { userCode: request.userCode }); await tokensPage();
    });
    button(item, 'Deny', async () => { await mutate('/api/auth/device/requests/deny', { userCode: request.userCode }); await tokensPage(); });
  }
  button(requests, 'Refresh requests', tokensPage);
  const create = form(content, 'Create an access token', async () => {
    const audience = access.value;
    const scopes = audience ? ['mcp:read', ...(audience === 'hosty:core' ? scopeInputs.filter(i => i.checked).map(i => i.value) : [])] : undefined;
    const issued = await mutate('/api/auth/credentials', { label: label.value, audience: audience || undefined, scopes });
    await tokensPage();
    const result = section('Copy your token now');
    element('p', 'This value is shown only once. Store it securely.', result);
    element('pre', issued.token, result).className = 'token';
    button(result, 'Hide token', () => result.remove()); result.scrollIntoView();
  });
  const label = input(create, 'Token label'); label.required = true;
  const choices = [['', 'Full host role — all operations available to your user']];
  if (session.user?.role === 'host.admin') choices.push(['hosty:core', 'Core MCP']);
  for (const app of roster.apps.filter(a => a.interfaces?.mcp?.length)) choices.push([app.id, `${app.displayName} MCP`]);
  const access = select(create, 'Access', choices);
  const scopes = element('div', undefined, create);
  element('p', 'Core MCP always includes read access. Select additional operations explicitly.', scopes);
  const scopeInputs = [['mcp:lifecycle', 'Start, stop and restart apps'], ['mcp:update', 'Update apps and Core'], ['mcp:core-restart', 'Restart Core']]
    .map(([scope, label]) => input(scopes, label, scope, 'checkbox'));
  access.onchange = () => { scopes.hidden = access.value !== 'hosty:core'; }; access.onchange();
  submit(create, 'Create token');
  const credentials = section('Your tokens and devices');
  if (!listing.credentials.length) element('p', 'No credentials.', credentials);
  const groups = new Map();
  for (const credential of listing.credentials) {
    const key = credential.oauthClientId || '';
    if (!groups.has(key)) {
      const group = element('section', undefined, credentials);
      element('h3', key ? `${credential.oauthClientName || 'OAuth client'} · ${key}` : 'Direct tokens and devices', group);
      groups.set(key, group);
    }
    const item = row(groups.get(key), credential.label || credential.kind,
      `${credential.audience || 'Full host role'} · ${(credential.scopes || []).join(', ')}`);
    element('p', `Fingerprint: ${credential.id} · User: ${credential.userDisplayName || credential.userId}`, item);
    element('p', `Created: ${new Date(credential.createdAt).toLocaleString()} · Last used: ${new Date(credential.lastSeenAt).toLocaleString()}`, item);
    if (credential.lastRefreshAt) element('p', `Last refresh: ${new Date(credential.lastRefreshAt).toLocaleString()}`, item);
    if (credential.lastRequestAt) element('p', `Last request: ${new Date(credential.lastRequestAt).toLocaleString()}`, item);
    if (session.user?.role === 'host.admin') {
      const label = input(item, 'Label', credential.label || '');
      button(item, 'Rename', async () => { await mutate(`/api/auth/credentials/${id(credential.id)}/label`, { label: label.value }, 'PATCH'); await tokensPage(); });
    }
    button(item, 'Revoke', async () => {
      if (!confirm(`Revoke ${credential.label || credential.kind} (${credential.id}) for ${credential.userDisplayName || credential.userId}?${credential.oauthClientId ? ' This revokes the entire OAuth grant, including refreshed credentials.' : ''}`)) return;
      await mutate(`/api/auth/credentials/${id(credential.id)}`, undefined, 'DELETE'); await tokensPage();
    });
  }
  if (session.user?.role === 'host.admin') {
    const clients = await read('/api/auth/oauth/clients');
    const registered = section('Registered OAuth clients');
    for (const client of clients.clients) {
      const item = row(registered, client.name, `${client.clientId} · ${client.liveGrants} active grants · ${client.redirectUris.join(', ')}`);
      button(item, 'Remove client', async () => {
        if (!confirm(`Remove ${client.name} (${client.clientId}) and revoke its grants?`)) return;
        await mutate('/api/auth/oauth/clients/' + id(client.clientId), undefined, 'DELETE'); await tokensPage();
      });
    }
  }
}

async function consentPage() {
  const requestId = new URL(location.href).searchParams.get('request');
  if (!requestId) throw new Error('Authorization request is missing. Start again from the connecting application.');
  const view = await read('/api/auth/oauth/requests/' + id(requestId));
  content.replaceChildren(); document.querySelector('h1').textContent = 'Authorize an application';
  const panel = section(view.clientName);
  element('p', `Acting as ${view.actingUser}. Access to ${view.audienceDisplayName} (${view.audience}).`, panel);
  element('p', `This request expires in ${view.expiresInSeconds} seconds.`, panel);
  const scopes = view.scopes.map(scope => {
    const labels = { 'mcp:read': 'Read MCP information', 'mcp:lifecycle': 'Start, stop and restart applications', 'mcp:update': 'Update applications and Core', 'mcp:core-restart': 'Restart Core' };
    const node = input(panel, labels[scope] || scope, scope, 'checkbox'); node.checked = scope === 'mcp:read';
    if (scope === 'mcp:read') node.disabled = true; return node;
  });
  async function decide(decision) {
    const result = await mutate(`/api/auth/oauth/requests/${id(view.id)}/decide`, {
      decision, scopes: scopes.filter(input => input.checked).map(input => input.value),
    });
    // The destination comes from Core's validated, parked OAuth request, never the page query.
    location.assign(result.redirectTo);
  }
  button(panel, 'Deny', () => decide('deny'));
  button(panel, 'Allow selected access', () => decide('approve')).className = 'primary';
}
void run(location.pathname === '/oauth/consent' ? consentPage : tokensPage);
