// Real Core password login, Harness identity and disposable child-Core workspace data.
// Supply { core, harness, link, email, password, outputDirectory? } on stdin.
// The caller owns the child environment and its cleanup. No provider prompts are sent.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const { chromium } = await import(process.env.HOSTY_WORK_PLAYWRIGHT_MODULE || 'playwright');
let input = ''; for await (const chunk of process.stdin) input += chunk;
const config = JSON.parse(input); input = '';
const secrets = new Set([config.password]);
const redact = value => {
  let result = String(value);
  for (const secret of secrets) if (secret) result = result.split(secret).join('[REDACTED]');
  return result.replace(/([?&](?:code|state|setupToken|recoveryToken)=)[^&\s]+/gi, '$1[REDACTED]');
};
const browser = await chromium.launch({ headless: true, channel: process.env.HOSTY_WORK_BROWSER_CHANNEL || 'chrome' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(30_000);
const errors = [], deleteRequests = [], sessionDeletes = [];
let messages = 0;
page.on('pageerror', error => errors.push(redact(error.message)));
page.on('request', request => {
  const pathname = new URL(request.url()).pathname;
  if (request.method() === 'POST' && pathname.endsWith('/messages')) messages++;
  if (request.method() === 'POST' && /^\/api\/development-workspaces\/[^/]+\/delete$/.test(pathname)) deleteRequests.push(pathname);
  if (request.method() === 'DELETE' && /^\/api\/sessions\/[^/]+$/.test(pathname)) sessionDeletes.push(pathname);
});

try {
  await page.goto(config.core + '/login?returnTo=%2Fapi%2Fauth%2Fsession');
  config.core = new URL(page.url()).origin;
  config.harness = new URL(config.harness).origin;
  await page.getByLabel('Email', { exact: true }).fill(config.email);
  await page.getByLabel('Password', { exact: true }).fill(config.password); config.password = '';
  await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === '/login' && response.request().method() === 'POST'),
    page.getByRole('button', { name: 'Sign in', exact: true }).click(),
  ]);
  const identity = await (await page.request.get(config.core + '/api/auth/session')).json();
  assert.equal(identity.authenticated, true, 'Normal child Core password login succeeds');
  const csrf = await (await page.request.get(config.core + '/api/auth/csrf')).json(); secrets.add(csrf.token);
  const appId = config.appId || 'hosty.harness';
  const verifier = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', ''); secrets.add(verifier);
  const launch = await page.request.post(config.core + '/api/apps/' + encodeURIComponent(appId) + '/launch-code', {
    headers: { Origin: config.core, 'X-Hosty-CSRF': csrf.token },
    data: { redirectUri: config.link, codeChallenge: createHash('sha256').update(verifier).digest('base64url'), codeChallengeMethod: 'S256' },
  });
  assert.equal(launch.status(), 200, 'Core issues the ordinary application launch code');
  const code = (await launch.json()).code; secrets.add(code);
  const exchange = await page.request.post(config.harness + '/api/auth/app-code', {
    headers: { Origin: config.harness }, data: { code, codeVerifier: verifier },
  });
  assert.equal(exchange.status(), 200, 'Harness accepts Core PKCE identity');

  const api = async (route, data, method = data === undefined ? 'GET' : 'POST') => {
    const response = await page.request.fetch(config.harness + '/api' + route, {
      method, headers: { Origin: config.harness }, ...(data === undefined ? {} : { data }), timeout: 180_000,
    });
    assert.equal(response.status(), 200, 'Synthetic child Harness API operation succeeds');
    return response.json();
  };
  const suffix = randomUUID().slice(0, 8);
  const titles = {
    standalone: 'Sessions QA standalone ' + suffix,
    first: 'Sessions QA implementation ' + suffix,
    second: 'Sessions QA review ' + suffix,
    workspace: 'Sessions QA workspace ' + suffix,
  };
  const standalone = await api('/sessions', { title: titles.standalone });
  const first = await api('/sessions', { title: titles.first });
  const tree = await api('/sessions/' + first.id + '/workspaces', {
    action: 'prepare', requestId: randomUUID(), appId: config.sourceAppId || appId,
    targetBranch: 'main', name: titles.workspace,
  });
  assert.ok(tree.workspaceId && tree.id && tree.path && tree.branch, 'Core prepares a real disposable workspace');
  const participants = await api('/development-workspaces/' + tree.workspaceId + '/participants');
  const second = await api('/workspace-sessions', {
    requestId: randomUUID(), workspaceId: tree.workspaceId, expectedRevision: participants.revision,
  });
  await api('/sessions/' + second.id, { title: titles.second }, 'PATCH');

  // Keep the background selection inspectable while Radix hides it from accessibility.
  const nav = page.locator('nav[aria-label="Sessions"]');
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const titleSpan = title => page.locator('span[title]').filter({ hasText: new RegExp('^' + escape(title) + '$') });
  const row = title => nav.locator('button').filter({ has: titleSpan(title) });
  const trash = () => nav.getByRole('button', { name: 'Delete workspace ' + titles.workspace, exact: true });
  const region = title => page.getByRole('region', { name: title, exact: true });
  const showNav = async () => {
    if (!await nav.isVisible()) await page.getByRole('button', { name: 'Show sessions', exact: true }).click();
    await nav.waitFor();
  };
  const assertGrouped = async () => {
    await row(titles.workspace).waitFor(); await row(titles.standalone).waitFor();
    assert.equal(await row(titles.workspace).count(), 1, 'One row represents the workspace');
    assert.equal(await row(titles.first).count(), 0, 'The first attached chat is not duplicated in Sessions');
    assert.equal(await row(titles.second).count(), 0, 'The second attached chat is not duplicated in Sessions');
    assert.equal(await nav.getByRole('button', { name: 'New session', exact: true }).isEnabled(), true);
  };
  const screenshot = async name => {
    if (!config.outputDirectory) return;
    await mkdir(config.outputDirectory, { recursive: true });
    await page.screenshot({ path: path.join(config.outputDirectory, name + '.png'), fullPage: true });
  };
  const openDelete = async () => {
    await row(titles.workspace).hover();
    await page.waitForFunction(element => getComputedStyle(element).opacity === '1', await trash().elementHandle());
    const url = page.url(), priorDeletes = deleteRequests.length;
    await trash().click();
    const dialog = page.getByRole('dialog', { name: 'Delete workspace?', exact: true });
    await dialog.waitFor();
    await dialog.getByRole('heading', { name: titles.workspace, exact: true }).waitFor();
    await dialog.getByText('Local branch: ' + tree.branch, { exact: true }).waitFor();
    assert.equal(await dialog.getByText(tree.path, { exact: true }).count(), 1, 'The existing dialog shows real Core deletion details');
    assert.equal(page.url(), url, 'Opening row Delete preserves the current URL');
    assert.equal(await row(titles.standalone).getAttribute('aria-current'), 'page', 'Delete does not select its workspace');
    assert.equal(deleteRequests.length, priorDeletes, 'Opening the dialog sends no deletion command');
    assert.equal(await dialog.getByRole('checkbox').count(), 0, 'Row Delete offers no unrelated conversation deletion');
    return dialog;
  };

  await page.goto(config.harness + '/chats/?session=' + encodeURIComponent(standalone.id));
  await nav.waitFor(); await region(titles.standalone).waitFor(); await assertGrouped();
  await screenshot('work-desktop');

  await nav.getByRole('textbox', { name: 'Search sessions', exact: true }).fill(titles.second);
  await row(titles.workspace).waitFor();
  assert.equal(await row(titles.second).count(), 0, 'Searching an attached title still returns the workspace');
  await row(titles.standalone).waitFor({ state: 'detached' });
  await nav.getByRole('textbox', { name: 'Search sessions', exact: true }).fill('');
  await row(titles.workspace).click();
  const details = page.getByRole('complementary', { name: 'Workspace details', exact: true });
  const sessions = details.getByRole('region', { name: 'Workspace sessions', exact: true });
  await sessions.getByRole('button', { name: 'Open session ' + titles.first, exact: true }).waitFor();
  await sessions.getByRole('button', { name: 'Open session ' + titles.second, exact: true }).waitFor();
  await sessions.getByRole('button', { name: 'Open session ' + titles.second, exact: true }).click();
  await region(titles.second).waitFor();
  await page.waitForFunction(id => new URL(location.href).searchParams.get('session') === id, second.id);
  assert.equal(await row(titles.workspace).getAttribute('aria-current'), 'page');
  await screenshot('work-desktop-details');

  await row(titles.standalone).click(); await region(titles.standalone).waitFor();
  await page.waitForFunction(id => new URL(location.href).searchParams.get('session') === id, standalone.id);
  let dialog = await openDelete(); await screenshot('work-delete');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.waitForFunction(element => document.activeElement === element, await trash().elementHandle());
  assert.equal(await trash().evaluate(element => document.activeElement === element), true, 'Cancel restores the row trash focus');
  assert.equal(deleteRequests.length, 0);

  await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ colorScheme: 'dark' });
  await showNav(); await assertGrouped();
  assert.ok(await page.locator('html').evaluate(element => element.scrollWidth <= innerWidth), 'Narrow Sessions does not overflow horizontally');
  await screenshot('work-narrow-dark');
  await row(titles.workspace).click();
  await page.getByRole('button', { name: 'Workspace details', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Workspace', exact: true });
  await sheet.getByRole('region', { name: 'Workspace sessions', exact: true })
    .getByRole('button', { name: 'Open session ' + titles.second, exact: true }).waitFor();
  assert.ok(await sheet.evaluate(element => element.scrollWidth <= element.clientWidth), 'Narrow workspace details fit the sheet');
  await screenshot('work-narrow-details-dark');
  await sheet.getByRole('button', { name: 'Back to conversation', exact: true }).click();
  await showNav(); await row(titles.standalone).click(); await region(titles.standalone).waitFor();
  await page.waitForFunction(id => new URL(location.href).searchParams.get('session') === id, standalone.id);
  await showNav(); dialog = await openDelete();
  await screenshot('work-narrow-delete-dark');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.waitForFunction(element => document.activeElement === element, await trash().elementHandle());
  assert.equal(await trash().evaluate(element => document.activeElement === element), true, 'Narrow Cancel restores trash focus');

  await page.setViewportSize({ width: 1440, height: 1000 }); await page.emulateMedia({ colorScheme: 'light' });
  dialog = await openDelete();
  const currentUrl = page.url();
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('dialog', { name: 'Workspace deleted', exact: true }).waitFor({ timeout: 180_000 });
  assert.deepEqual(deleteRequests, ['/api/development-workspaces/' + tree.workspaceId + '/delete'], 'Only the explicitly confirmed disposable workspace is deleted');
  assert.deepEqual(sessionDeletes, [], 'Workspace row deletion deletes no chat');
  assert.equal(page.url(), currentUrl, 'Deleting another workspace preserves the current chat URL');
  await page.getByRole('dialog', { name: 'Workspace deleted', exact: true }).locator('[data-slot="dialog-footer"]')
    .getByRole('button', { name: 'Close', exact: true }).click();
  await row(titles.workspace).waitFor({ state: 'detached' });
  await row(titles.first).waitFor(); await row(titles.second).waitFor(); await row(titles.standalone).waitFor();
  assert.equal(await row(titles.standalone).getAttribute('aria-current'), 'page');
  await page.waitForFunction(element => document.activeElement === element, await nav.getByRole('button', { name: 'New session', exact: true }).elementHandle());
  assert.equal(await nav.getByRole('button', { name: 'New session', exact: true }).evaluate(element => document.activeElement === element), true, 'Removed-row focus falls back to New session');
  for (const session of [standalone, first, second]) assert.equal((await api('/sessions/' + session.id)).id, session.id, 'Accessible chats survive workspace deletion');
  await screenshot('work-retained-chats');
  assert.equal(messages, 0, 'The acceptance sends no provider prompts');
  assert.deepEqual(errors, [], 'Sessions has no browser runtime errors');
  console.log('PASS: child Core password login and PKCE, unified Sessions grouping/search, workspace sessions, desktop/narrow layout, hover Delete details/cancel/focus, explicit workspace deletion and retained chats; no inference.');
} catch (error) {
  console.error(redact(error instanceof Error ? error.stack || error.message : error));
  process.exitCode = 1;
} finally { await browser.close(); }
