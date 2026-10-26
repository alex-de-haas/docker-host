import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { OpusWorker } from './worker.js';
import { TranslationService } from './service.js';
import { createApp } from './server.js';
const cache = process.env.HOSTY_APP_CACHE_DIR;
if (!cache || !process.env.HOSTY_APP_ID || !process.env.HOSTY_APP_SERVICE_TOKEN || !process.env.HOSTY_CORE_ORIGIN)
  throw new Error('Run OPUS Translate through Hosty with app credentials and cache configured.');
const threads = Number(process.env.OPUS_THREADS ?? '8');
if (!Number.isInteger(threads) || threads < 1 || threads > 32) throw new Error('OPUS_THREADS must be an integer from 1 to 32.');
const port = Number(process.env.HOSTY_PORT_HTTP ?? process.env.PORT ?? '3510');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid HTTP port.');
const python = join(resolve(cache), 'python', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const worker = new OpusWorker(python, [fileURLToPath(new URL('../runtime/worker.py', import.meta.url)), join(resolve(cache), 'models'), String(threads)]);
const server = createApp(new TranslationService(worker));
server.listen(port, '127.0.0.1', () => console.info('OPUS Translate is running; the model initializes in the background.'));
void worker.start().then(() => console.info('OPUS-MT Big is ready (English to Russian, CPU INT8).')).catch(() => console.error('OPUS model initialization failed; check app setup and cache, then restart.'));
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  server.close();
  await worker.stop();
  server.closeAllConnections();
};
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
