import { redact, appNavigation } from './policy.mjs';
import { chromium } from 'playwright';

// Private managed stdio is the only control channel. No HTTP/CDP listener, arbitrary JS,
// filesystem paths, storage-state export, or caller-provided launch options are accepted.
let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 131072) throw new Error('Worker input limit exceeded');
}
const job = JSON.parse(input); input = '';
const target = new URL(job.target);
const auth = new URL(job.authOrigin);
const allowed = new Set(job.endpoints.map(value => new URL(value).origin));
if (!allowed.has(target.origin) || target.protocol !== 'http:' || auth.protocol !== 'http:' || !Array.isArray(job.actions) || job.actions.length > 50)
  throw new Error('Invalid reviewed browser target');
const browser = await chromium.launch({ headless: true, chromiumSandbox: true,
  proxy: { server: job.proxy }, args: ['--proxy-bypass-list=<-loopback>', '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] });
const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false, viewport: { width: 1280, height: 800 } });
context.setDefaultTimeout(30000);
let login = true;
let loginStage = 'navigation';
const loginResponses = [];
let loginPolicyBlocked = false;
let page;
const report = { state: 'failed', assertions: [], screenshots: [], console: [], network: [], errorCode: null };

await context.route('**/*', async route => {
  const url = new URL(route.request().url());
  const allowedAuth = login && url.origin === auth.origin && url.pathname === '/login';
  if (!allowed.has(url.origin) && !allowedAuth || url.username || url.password) return route.abort();
  if (!login && url.pathname.startsWith('/_hosty/')) return route.abort();
  await route.continue();
});
context.on('page', extra => { if (page && extra !== page) void extra.close(); });
try {
  page = await context.newPage();
  page.on('dialog', dialog => void dialog.dismiss());
  page.on('console', event => { if (login && /Content Security Policy/i.test(event.text())) loginPolicyBlocked = true; });
  page.on('download', download => void download.cancel());
  page.on('response', async response => {
    if (!login || !response.request().isNavigationRequest() || loginResponses.length >= 8) return;
    const url = new URL(response.url());
    const item = { phase: url.origin === auth.origin ? 'login' : url.pathname === '/_hosty/callback' ? 'callback' : 'app', status: response.status() };
    loginResponses.push(item);
    if (response.status() >= 400 && response.headers()['content-type']?.includes('application/json')) {
      try { const body = await response.json(); if (/^sandbox_[a-z_]+$/.test(body.code)) item.code = body.code; } catch {}
    }
  });
  await page.goto(target.href, { waitUntil: 'domcontentloaded' });
  loginStage = 'form';
  if (new URL(page.url()).origin !== auth.origin) throw new Error('sandbox_login_origin_invalid');
  await page.locator('input[name="loginId"]').fill(job.loginId);
  await page.locator('input[name="password"]').fill(job.password);
  loginStage = 'callback';
  await Promise.all([page.waitForURL(url => allowed.has(url.origin) && !url.pathname.startsWith('/_hosty/')), page.locator('button[type="submit"]').click()]);
  job.loginId = ''; job.password = ''; login = false;
  page.on('console', event => { if (report.console.length < 100) report.console.push({ type: event.type(), text: redact(event.text()) }); });
  page.on('response', response => { if (report.network.length < 100) { const url = new URL(response.url()); report.network.push({ path: url.pathname.slice(0, 300), status: response.status() }); } });
  for (let index = 0; index < job.actions.length; index++) {
    const action = job.actions[index];
    if (!allowed.has(new URL(page.url()).origin)) throw new Error('sandbox_target_changed');
    const locator = action.selector ? page.locator(action.selector) : null;
    switch (action.kind) {
      case 'navigate': {
        const url = appNavigation(action.path, target);
        await page.goto(url.href, { waitUntil: 'domcontentloaded' }); break;
      }
      case 'click': await locator.click(); break;
      case 'fill': await locator.fill(action.value); break;
      case 'assert-visible': await locator.waitFor({ state: 'visible' }); break;
      case 'assert-text': {
        const value = await locator.innerText();
        if (!value.includes(action.value)) throw new Error('sandbox_assertion_failed'); break;
      }
      case 'screenshot': {
        if (report.screenshots.length >= 3) throw new Error('sandbox_capture_quota');
        const picture = await page.screenshot({ type: 'jpeg', quality: 75, fullPage: false });
        if (picture.length > 5 * 1024 * 1024) throw new Error('sandbox_capture_quota');
        report.screenshots.push({ step: index, mimeType: 'image/jpeg', base64: picture.toString('base64') }); break;
      }
      default: throw new Error('sandbox_action_invalid');
    }
    report.assertions.push({ step: index, kind: action.kind, state: 'passed' });
  }
  report.state = 'passed';
} catch (error) {
  // Playwright errors may include DOM snapshots, filled values and login URLs. Export only
  // a closed error code plus successful step indices, never the raw exception/stack.
  if (login) report.login = { stage: loginStage, responses: loginResponses, policyBlocked: loginPolicyBlocked, failure: error.message.match(/net::ERR_[A-Z_]+/)?.[0] ?? (error.name === 'TimeoutError' ? 'timeout' : 'browser_error') };
  report.errorCode = /^sandbox_[a-z_]+$/.test(error.message) ? error.message : login ? 'sandbox_login_failed' : 'sandbox_browser_action_failed';
} finally {
  await context.close(); await browser.close();
}
process.stdout.write(JSON.stringify(report));
