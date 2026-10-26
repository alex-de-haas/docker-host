import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { ProviderClient } from '@hosty-sdk/app/providers/server';
import { ProviderError } from '@hosty-sdk/app/providers';
import { MAX_BYTES, TIMEOUT_SECONDS, type TranslationService } from './service.js';

export type Authorize = (token: string, signal: AbortSignal) => Promise<unknown>;
export function createApp(service: TranslationService, authorize: Authorize = (token, signal) => new ProviderClient().validate(token, 'translation', 'default', signal)) {
  return createServer({ requestTimeout: 30_000, headersTimeout: 15_000, maxHeaderSize: 16_384 }, (request, response) => {
    void handle(request, response, service, authorize).catch(() => {
      if (!response.destroyed && !response.headersSent) send(response, 500, { code: 'translation_failed', message: 'Local translation failed.' });
    });
  });
}
const send = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
};
async function handle(request: IncomingMessage, response: ServerResponse, service: TranslationService, authorize: Authorize) {
  const controller = new AbortController(), cancel = () => controller.abort();
  response.once('close', cancel);
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(TIMEOUT_SECONDS * 1000)]);
  try {
    const path = new URL(request.url ?? '/', 'http://local').pathname;
    if (path === '/healthz' && request.method === 'GET') { send(response, 200, { status: 'running' }); return; }
    const action = /^\/api\/translation\/v1\/(capabilities|translations)$/.exec(path)?.[1];
    if (!action) throw new ProviderError('not_found', 'Unknown endpoint.', 404);
    const token = request.headers.authorization?.match(/^Bearer (\S+)$/i)?.[1];
    if (!token) throw new ProviderError('token_required', 'A Core translation provider credential is required.', 401);
    try { await authorize(token, signal); }
    catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('core_unavailable', 'Core provider authorization is unavailable.', 503);
    }
    if (action === 'capabilities' && request.method === 'GET') { send(response, 200, service.capabilities()); return; }
    if (action !== 'translations' || request.method !== 'POST') throw new ProviderError('method_not_allowed', 'Use GET capabilities or POST translations.', 405);
    if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new ProviderError('translation_media_type', 'Send application/json.', 415);
    const data = await readBody(request, signal);
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)); }
    catch { throw new ProviderError('translation_invalid', 'Send valid UTF-8 JSON.', 400); }
    const result = await service.translate(value, signal);
    if (!response.destroyed) send(response, 200, result);
  } catch (error) {
    if (!response.destroyed) {
      // Closing after a rejected body avoids keeping a partially consumed upload alive.
      response.setHeader('connection', 'close');
      if (signal.aborted) send(response, signal.reason?.name === 'TimeoutError' ? 504 : 499, { code: 'translation_cancelled', message: 'Translation was cancelled or timed out.' });
      else if (error instanceof ProviderError) send(response, error.status, { code: error.code, message: error.message });
      else send(response, 502, { code: 'translation_failed', message: 'The local model could not complete translation.' });
    }
  } finally { response.off('close', cancel); }
}
function readBody(request: IncomingMessage, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    const clean = () => { request.off('data', data); request.off('end', end); request.off('error', fail); request.off('aborted', abort); signal.removeEventListener('abort', abort); };
    const fail = (error: unknown) => { clean(); request.pause(); reject(error); };
    const abort = () => fail(new ProviderError('translation_cancelled', 'Translation upload was cancelled.', 408));
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BYTES) { fail(new ProviderError('translation_too_large', 'Request exceeds the one MiB limit.', 413)); return; }
      chunks.push(chunk);
    };
    const end = () => { clean(); resolve(Buffer.concat(chunks)); };
    request.on('data', data); request.once('end', end); request.once('error', fail); request.once('aborted', abort); signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
