// Real managed-child login, production UI/MediaRecorder and real speech HTTP responses.
// Chromium's controlled WAV microphone avoids accessing the operator's physical microphone.
// Maximum upload/cancellation uses a generated 600-second fixture; UI capture runs in real time
// for a few seconds. This does not claim ten minutes of wall-clock microphone capture.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const { chromium } = await import(process.env.HOSTY_SPEECH_PLAYWRIGHT_MODULE || process.env.HOSTY_QUEUE_PLAYWRIGHT_MODULE || 'playwright');
let input = ''; for await (const chunk of process.stdin) input += chunk;
const config = JSON.parse(input); input = '';
assert.ok(config.appId && config.microphoneFile && config.russianFile && config.speechQuery);
config.core = new URL(config.core).origin;
assert.equal(new URL(config.link).origin, config.harness, 'Use the Core-advertised Harness launch origin');
const browser = await chromium.launch({ headless: true, channel: process.env.HOSTY_SPEECH_BROWSER_CHANNEL || 'chrome',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${config.microphoneFile}`] });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await context.grantPermissions(['microphone'], { origin: config.harness });
await context.addInitScript(() => {
  const media = navigator.mediaDevices;
  if (!media) return;
  const original = media.getUserMedia.bind(media);
  media.getUserMedia = async constraints => {
    const stream = await original(constraints);
    (globalThis.fixtureMicrophoneTracks ??= []).push(...stream.getTracks());
    return stream;
  };
});
const page = await context.newPage(), errors = [];
page.on('pageerror', error => errors.push(error.message));
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
try {
  await page.goto(config.core+'/login?returnTo=%2Fapi%2Fauth%2Fsession'); config.core = new URL(page.url()).origin;
  await page.getByLabel('Email', { exact: true }).fill(config.email);
  await page.getByLabel('Password', { exact: true }).fill(config.password); config.password = '';
  await Promise.all([page.waitForResponse(response => new URL(response.url()).pathname === '/login' && response.request().method() === 'POST'),
    page.getByRole('button', { name: 'Sign in', exact: true }).click()]);
  assert.equal((await (await page.request.get(config.core+'/api/auth/session')).json()).authenticated, true);
  const csrf = await (await page.request.get(config.core+'/api/auth/csrf')).json();
  const verifier = randomUUID().replaceAll('-', '')+randomUUID().replaceAll('-', '');
  const code = await page.request.post(`${config.core}/api/apps/${encodeURIComponent(config.appId)}/launch-code`, {
    headers: { Origin: config.core, 'X-Hosty-CSRF': csrf.token },
    data: { redirectUri: config.link, codeChallenge: createHash('sha256').update(verifier).digest('base64url'), codeChallengeMethod: 'S256' } });
  assert.equal(code.status(), 200);
  const exchange = await page.request.post(config.harness+'/api/auth/app-code', { headers: { Origin: config.harness },
    data: { code: (await code.json()).code, codeVerifier: verifier } }); assert.equal(exchange.status(), 200);
  const caps = await page.request.get(`${config.harness}/api/speech/capabilities?${config.speechQuery}`);
  assert.equal(caps.status(), 200); assert.ok((await caps.json()).maxDurationSeconds >= 600);
  const created = await page.request.post(config.harness+'/api/sessions', { headers: { Origin: config.harness },
    data: { title: 'Controlled speech draft acceptance' } });
  assert.equal(created.status(), 200); const session = await created.json();
  let sends = 0, transcriptions = 0;
  page.on('request', request => {
    if (request.method() !== 'POST') return;
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/messages') || path.endsWith('/message-queue/commands') && request.postDataJSON()?.command?.type === 'enqueue') sends++;
    if (path === '/api/speech/transcriptions') transcriptions++;
  });
  const preview = new URL(config.link); preview.searchParams.set('session', session.id); preview.searchParams.set('hosty_launch', 'standalone');
  await page.goto(preview.href);
  const message = page.getByRole('textbox', { name: 'Message', exact: true });
  await message.waitFor(); await message.fill('Keep this draft:');
  const dictate = page.getByRole('button', { name: 'Dictate', exact: true });
  await page.waitForFunction(() => !document.querySelector('button[aria-label="Dictate"]')?.disabled);
  await dictate.click();
  const timer = page.getByRole('timer'); await timer.waitFor(); assert.match(await timer.getAttribute('aria-label'), /10:00/);
  await pause(5500);
  await page.getByRole('button', { name: 'Stop recording', exact: true }).click();
  await page.waitForFunction(() => /привет/i.test(document.querySelector('textarea[aria-label="Message"]')?.value || ''), undefined, { timeout: 60_000 });
  const recognized = await message.inputValue(); assert.ok(recognized.startsWith('Keep this draft: '));
  assert.equal(sends, 0); assert.equal(transcriptions, 1);
  await dictate.waitFor(); await dictate.click(); await timer.waitFor(); await pause(250);
  await page.getByRole('button', { name: 'Cancel dictation', exact: true }).click(); await dictate.waitFor();
  assert.equal(await message.inputValue(), recognized); assert.equal(transcriptions, 1);
  assert.equal(await page.evaluate(() => globalThis.fixtureMicrophoneTracks.length >= 2 && globalThis.fixtureMicrophoneTracks.every(track => track.readyState === 'ended')), true);

  const russianBase64 = (await readFile(config.russianFile)).toString('base64');
  await page.evaluate(({ russianBase64, query }) => {
    const source = Uint8Array.from(atob(russianBase64), character => character.charCodeAt(0)), sourceView = new DataView(source.buffer);
    let pcm;
    for (let at = 12; at + 8 <= source.length;) {
      const size = sourceView.getUint32(at + 4, true);
      if (String.fromCharCode(...source.slice(at, at + 4)) === 'data') { pcm = source.subarray(at + 8, at + 8 + size); break; }
      at += 8 + size + (size & 1);
    }
    if (!pcm?.length) throw Error('Controlled Russian PCM fixture is missing');
    const bytes = new Uint8Array(44 + 600 * 16000 * 2), view = new DataView(bytes.buffer);
    const text = (at, value) => { for (let index = 0; index < value.length; index++) bytes[at + index] = value.charCodeAt(index); };
    text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    text(36, 'data'); view.setUint32(40, bytes.length - 44, true);
    for (let at = 44; at < bytes.length; at += pcm.length) bytes.set(pcm.subarray(0, Math.min(pcm.length, bytes.length - at)), at);
    const controller = new AbortController(); globalThis.fixtureSpeechAbort = controller;
    globalThis.fixtureSpeechState = 'pending';
    void fetch('/api/speech/transcriptions?'+query, { method: 'POST', headers: { 'Content-Type': 'audio/wav' },
      body: bytes, signal: controller.signal }).then(async response => {
      await response.arrayBuffer(); globalThis.fixtureSpeechState = 'completed';
    }).catch(error => { globalThis.fixtureSpeechState = error.name === 'AbortError' ? 'aborted' : 'failed'; });
  }, { russianBase64, query: config.speechQuery });
  // This cancellation scenario requires a single-slot provider returning speech_busy and empty
  // text for silence; it is not a concurrency contract for every speech provider.
  // Probe the real provider slot, so cancellation happens after provider admission rather than just
  // discarding a browser promise before the audio reached Harness/provider.
  const silence = Buffer.alloc(44 + 16000 * 2);
  silence.write('RIFF'); silence.writeUInt32LE(silence.length - 8, 4); silence.write('WAVE', 8); silence.write('fmt ', 12);
  silence.writeUInt32LE(16, 16); silence.writeUInt16LE(1, 20); silence.writeUInt16LE(1, 22);
  silence.writeUInt32LE(16000, 24); silence.writeUInt32LE(32000, 28); silence.writeUInt16LE(2, 32); silence.writeUInt16LE(16, 34);
  silence.write('data', 36); silence.writeUInt32LE(silence.length - 44, 40);
  const probe = () => page.request.post(`${config.harness}/api/speech/transcriptions?${config.speechQuery}`, {
    headers: { Origin: config.harness, 'Content-Type': 'audio/wav' }, data: silence, timeout: 30_000 });
  let admitted = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await probe();
    if (response.status() === 429) { assert.equal((await response.json()).code, 'speech_busy'); admitted = true; break; }
    assert.equal(response.status(), 200);
    assert.equal(await page.evaluate(() => globalThis.fixtureSpeechState), 'pending', 'Maximum speech request finished before cancellation was observed');
    await pause(25);
  }
  assert.ok(admitted, 'This fixture requires an observable single recognition slot (speech_busy)');
  const began = Date.now(); await page.evaluate(() => globalThis.fixtureSpeechAbort.abort());
  await page.waitForFunction(() => globalThis.fixtureSpeechState === 'aborted');
  let recovered = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await probe();
    if (response.status() === 200) { assert.equal((await response.json()).text, '', 'This fixture requires empty recognition for synthetic silence'); recovered = true; break; }
    assert.equal(response.status(), 429); await pause(50);
  }
  assert.ok(recovered, 'Real provider recognition slot did not recover after the HTTP abort');
  assert.equal(await message.inputValue(), recognized); assert.equal(sends, 0);
  const queue = await page.request.get(`${config.harness}/api/sessions/${session.id}/message-queue`);
  assert.equal(queue.status(), 200); assert.deepEqual((await queue.json()).entries, []);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ fixture: 'Managed child production speech UI with controlled WAV microphone', browser: await browser.version(),
    captureWallSeconds: 5.5, capabilityMaxSeconds: 600, microphoneTracksEnded: true, automaticSends: sends,
    cancellation: { maximumPayloadSeconds: 600, actualProviderBusyObserved: true, browserHttpAbortObserved: true, slotRecoveredMs: Date.now()-began },
    limits: 'Short real-time MediaRecorder capture and independent maximum HTTP payload. No physical microphone, ten-minute wall-clock capture, natural speech quality or total renderer/native memory claim.' }));
  console.log('PASS: Core-advertised password login/launch, production dictation capability and duration UI, real transcript inserted only into draft, microphone release, cancelled maximum HTTP request and real provider slot recovery.');
} finally { await browser.close(); }
