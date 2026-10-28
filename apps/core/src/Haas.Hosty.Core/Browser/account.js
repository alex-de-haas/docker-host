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
  const wrapper = element('label', undefined, parent);
  wrapper.className = type === 'checkbox' ? 'account-choice' : 'account-field';
  element('span', label, wrapper);
  const node = element('input', undefined, wrapper); node.type = type; node.value = value; return node;
}
function select(parent, label, choices) {
  const wrapper = element('label', undefined, parent);
  wrapper.className = 'account-field';
  element('span', label, wrapper);
  const node = element('select', undefined, wrapper);
  for (const [value, label] of choices) { const option = element('option', label, node); option.value = value; }
  return node;
}
function form(parent, title, submit) {
  const node = element('form', undefined, parent); element('h2', title, node);
  node.onsubmit = event => { event.preventDefault(); void run(() => submit(node), node.querySelector('[type=submit]')); };
  return node;
}
function actions(parent) { const node = element('div', undefined, parent); node.className = 'actions'; return node; }
function submit(parent, label) { const b = element('button', label, actions(parent)); b.type = 'submit'; b.className = 'primary'; }
function permissionGroup(parent, title) {
  const node = element('fieldset', undefined, parent); node.className = 'account-choices';
  element('legend', title, node); return node;
}
function fields(parent) { const node = element('div', undefined, parent); node.className = 'account-fields'; return node; }
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
  const [session, roster] = await Promise.all([read('/api/auth/session'), read('/api/apps')]);
  content.replaceChildren();
  const create = form(content, 'Create an access token', async () => {
    const audience = access.value;
    const scopes = audience ? ['mcp:read', ...(audience === 'hosty:core' ? scopeInputs.filter(i => i.checked).map(i => i.value) : [])] : undefined;
    const issued = await mutate('/api/auth/credentials', { label: label.value, audience: audience || undefined, scopes });
    content.replaceChildren();
    const result = section('Copy your token now');
    element('p', 'This value is shown only once. Store it securely.', result);
    element('pre', issued.token, result).className = 'token';
    button(actions(result), 'Hide token', () => result.remove()); result.scrollIntoView();
  });
  const label = input(create, 'Token label'); label.required = true;
  const choices = [['', 'Full host role — all operations available to your user']];
  if (session.user?.role === 'host.admin') choices.push(['hosty:core', 'Core MCP']);
  for (const app of roster.apps.filter(a => a.interfaces?.mcp?.length)) choices.push([app.id, `${app.displayName} MCP`]);
  const access = select(create, 'Access', choices);
  const scopes = permissionGroup(create, 'Core MCP permissions');
  element('p', 'Core MCP always includes read access. Select additional operations explicitly.', scopes);
  const scopeInputs = [['mcp:lifecycle', 'Start, stop and restart apps'], ['mcp:update', 'Update apps and Core'], ['mcp:core-restart', 'Restart Core'], ['mcp:workspaces', 'Create, read and manage your external development workspaces']]
    .map(([scope, label]) => input(scopes, label, scope, 'checkbox'));
  access.onchange = () => { scopes.hidden = access.value !== 'hosty:core'; }; access.onchange();
  submit(create, 'Create token');

}
async function devicePage() {
  content.replaceChildren();
  const deviceForm = form(content, 'Authorize a device', async () => {
    await mutate('/api/auth/device/requests/approve', { userCode: code.value });
    content.replaceChildren(); element('p', 'Device authorized. You can close this window.');
  });
  element('p', 'Enter only the code displayed by a device you are connecting. It will act with your host role.', deviceForm);
  const code = input(deviceForm, 'Device code'); code.required = true;
  submit(deviceForm, 'Authorize device');
}

async function backgroundSection(apps) {
  const root = section('Background app access');
  element('p', 'These explicit grants allow an app to work after tabs close and after ordinary sign-out. Revoke a grant here to stop new calls. Updating an app cannot add actions to a saved grant.', root);
  const create = form(root, 'Authorize background work', async () => {
    const scope = { id: 'work', kind: kind.value, targetAppId: target.value, actions: [] };
    if (kind.value === 'core') scope.actions = actions.filter(i => i.checked).map(i => i.value);
    if (kind.value === 'mcp') scope.actions = tools.value.split(',').map(v => v.trim()).filter(Boolean);
    if (kind.value === 'provider') { scope.providerKind = provider.value; scope.key = key.value; }
    const expiresAt = expiry.value ? new Date(expiry.value).toISOString() : null;
    if (!confirm(`Allow ${consumer.value} to use ${scope.kind} access on ${scope.targetAppId}: ${scope.actions.join(', ') || scope.providerKind + '/' + scope.key}? ${expiresAt ? 'Expires ' + expiresAt : 'Until revoked'}. This survives sign-out.`)) return;
    await mutate('/api/auth/background-grants', { appId: consumer.value, label: label.value, scopes: [scope], expiresAt });
    content.replaceChildren(); element("p", "Background access authorized. You can close this window.");
  });
  const label = input(create, 'Purpose'); label.required = true;
  const consumer = select(create, 'App performing the work', apps.map(a => [a.id, a.displayName]));
  const kind = select(create, 'Access type', [['core', 'Manage a selected app'], ['provider', 'Use a selected provider'], ['mcp', 'Call selected MCP tools']]);
  const target = select(create, 'Target', [...apps.map(a => [a.id, a.displayName]), ['hosty:core', 'Core MCP (MCP access only)']]);
  const coreFields = permissionGroup(create, 'Allowed operations');
  const actions = ['health', 'update-status', 'update-plan', 'update', 'start', 'stop', 'restart'].map(a => input(coreFields, a, a, 'checkbox'));
  const providerFields = fields(create);
  const provider = select(providerFields, 'Provider', [['assistant', 'Assistant'], ['speech-to-text', 'Speech to text']]);
  const key = input(providerFields, 'Interface key', 'default');
  const mcpFields = fields(create);
  const tools = input(mcpFields, 'Exact tool names, separated by commas');
  element('p', 'Each selected tool may use its full argument domain at this target. This does not restrict file paths or workspaces.', mcpFields);
  const expiry = input(create, 'Optional expiry — leave empty for until revoked', '', 'datetime-local');
  kind.onchange = () => { coreFields.hidden = kind.value !== 'core'; providerFields.hidden = kind.value !== 'provider'; mcpFields.hidden = kind.value !== 'mcp'; };
  kind.onchange(); submit(create, 'Authorize selected background access');
}

async function consentPage() {
  const requestId = new URL(location.href).searchParams.get('request');
  if (!requestId) throw new Error('Authorization request is missing. Start again from the connecting application.');
  const view = await read('/api/auth/oauth/requests/' + id(requestId));
  content.replaceChildren(); document.querySelector('h1').textContent = 'Authorize an application';
  const panel = section(view.clientName);
  element('p', `Acting as ${view.actingUser}. Access to ${view.audienceDisplayName} (${view.audience}).`, panel);
  element('p', `This request expires in ${view.expiresInSeconds} seconds.`, panel);
  const permissions = permissionGroup(panel, 'Requested permissions');
  const scopes = view.scopes.map(scope => {
    const labels = { 'mcp:read': 'Read MCP information', 'mcp:lifecycle': 'Start, stop and restart applications', 'mcp:update': 'Update applications and Core', 'mcp:core-restart': 'Restart Core', 'mcp:workspaces': 'Create, read and manage your external development workspaces (source files and Git operations)' };
    const node = input(permissions, labels[scope] || scope, scope, 'checkbox'); node.checked = scope === 'mcp:read';
    if (scope === 'mcp:read') node.disabled = true; return node;
  });
  async function decide(decision) {
    const result = await mutate(`/api/auth/oauth/requests/${id(view.id)}/decide`, {
      decision, scopes: scopes.filter(input => input.checked).map(input => input.value),
    });
    // The destination comes from Core's validated, parked OAuth request, never the page query.
    location.assign(result.redirectTo);
  }
  const controls = actions(panel);
  button(controls, 'Deny', () => decide('deny'));
  button(controls, 'Allow selected access', () => decide('approve')).className = 'primary';
}
void run(location.pathname === '/oauth/consent' ? consentPage : location.pathname === '/account/device' ? devicePage
  : location.pathname === '/account/background' ? async () => { const roster = await read('/api/apps'); content.replaceChildren(); await backgroundSection(roster.apps); } : tokensPage);
