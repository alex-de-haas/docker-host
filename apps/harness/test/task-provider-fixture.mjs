// Independent conformance producer/executor. Only installed in disposable integration Cores.
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { ProviderClient } from '@hosty-sdk/app/providers/server';
import { TaskClient, TaskExecutorClient } from '@hosty-sdk/app/tasks/server';
const providers = new ProviderClient();
const root = process.env.HOSTY_APP_DATA_DIR + '/task-fixture';
await mkdir(root, { recursive: true });
createServer(async (req, res) => {
  const reply = (status, value) => { res.writeHead(status, {'content-type':'application/json'}); res.end(JSON.stringify(value)); };
  try {
    const route = new URL(req.url, 'http://fixture').pathname;
    if (route === '/healthz') return reply(200, { appId: process.env.HOSTY_APP_ID, installationId: process.env.HOSTY_APP_INSTALLATION_ID, key: 'default' });
    let bytes = ''; for await (const part of req) { bytes += part; if (bytes.length > 200000) throw new Error('Request too large'); }
    const body = bytes ? JSON.parse(bytes) : {};
    if (route === '/produce') {
      const client = new TaskClient(providers, body.provider, async () => req.headers['x-hosty-user-token']);
      return reply(201, await client.create(body.request));
    }
    if (route === '/invoke') {
      const client = new TaskExecutorClient(providers, body.executor, async () => req.headers['x-hosty-user-token']);
      const value = body.operation === 'cancel' ? await client.cancel(body.id, body.requestId)
        : body.operation === 'get' ? await client.get(body.id) : await client.accept(body.id, body.input);
      return reply(200, value);
    }
    const token = req.headers.authorization?.replace(/^Bearer /i, '') ?? '';
    const operation = route === '/v1/options' ? 'dispatch.options' : route.endsWith('/cancel') ? 'dispatch.cancel' : req.method === 'PUT' ? 'dispatch.accept' : 'dispatch.get';
    let auth;
    if (token.startsWith('hosty_provider.2.')) {
      try { auth = await providers.validateMediated(token, 'task-executor', { operation, method: req.method, path: route.slice('/v1'.length), body: bytes }); }
      catch (error) {
        if (route !== '/v1/options' || error.code !== 'token_invalid') throw error;
        auth = await providers.validateMediated(token, 'task-executor', { operation: 'options', method: req.method, path: '/options', body: bytes });
      }
    } else {
      try { auth = await providers.validate(token, 'task-executor'); }
      catch (error) { console.error('Fixture provider introspection failed', JSON.stringify({ route, method: req.method, format: token.startsWith('hosty_provider.') ? token.split('.').slice(0, 2).join('.') : 'unexpected', tokenLength: token.length, code: error.code })); throw error; }
    }
    if (route === '/v1/options') return reply(200, { version: 1, revision: 1, options: [{ id: 'default', revision: 1, name: 'Plain executor', description: 'Independent executor with no profile concept', capabilities: ['markdown'], availability: { state: 'available' } }], defaultId: 'default' });
    const match = route.match(/^\/v1\/executions\/([a-f0-9-]{36})(\/cancel)?$/);
    if (!match) return reply(404, {code:'not_found'});
    const id = match[1], key = createHash('sha256').update(auth.callerAppId+auth.callerInstallation+id).digest('hex');
    const file = root+'/'+key+'.json'; let record;
    try { record = JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const now = new Date().toISOString();
    const receipt = () => ({ executionId:id, revision:1, state:'accepted', stopConfirmed:false, createdAt:now, updatedAt:now });
    if (req.method === 'PUT') {
      const hash = JSON.stringify(body);
      if (record?.hash && record.hash !== hash) return reply(409, {code:'execution_conflict', message:'Different input'});
      if (!record) record = { hash, receipt:receipt(), input:body };
    } else if (match[2] && req.method === 'POST') {
      record ??= { receipt:receipt() }; record.receipt = { ...record.receipt, revision:record.receipt.revision+1, state:'cancelled', stopConfirmed:true };
    } else if (!record) return reply(404, {code:'execution_not_found', message:'No acceptance'});
    else if (record.receipt.state === 'accepted') {
      record.receipt = { ...record.receipt, revision:2, state:'completed', stopConfirmed:true, result:{ markdown:'Independent executor result; no profile concept.', resources:[] } };
    }
    await writeFile(file+'.tmp', JSON.stringify(record)); await rename(file+'.tmp', file);
    reply(req.method === 'PUT' ? 202 : 200, record.receipt);
  } catch (e) { reply(e.status ?? 500, { code:e.code ?? 'fixture_failure', message:e.message }); }
}).listen(3410, '0.0.0.0');
