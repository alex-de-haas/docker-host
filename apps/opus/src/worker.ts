import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { ProviderError } from '@hosty-sdk/app/providers';

export interface TranslationEngine {
  readonly ready: boolean;
  readonly reason: string | undefined;
  translate(texts: string[], signal: AbortSignal): Promise<string[]>;
}
type Pending = { resolve(value: unknown): void; reject(error: Error): void };
export function workerEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { PYTHONUNBUFFERED: '1', PYTHONNOUSERSITE: '1' };
  for (const key of ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'WINDIR', 'TMP', 'TEMP', 'TMPDIR', 'LANG', 'LC_ALL'])
    if (process.env[key]) result[key] = process.env[key];
  return result;
}

/** One resident worker; interrupted requests are terminated, never replayed into a new worker. */
export class OpusWorker implements TranslationEngine {
  ready = false;
  reason: string | undefined = 'The local translation model is loading.';
  private child?: ChildProcessWithoutNullStreams;
  private pending?: Pending;
  private starting?: Promise<void>;
  private closed?: Promise<void>;
  private stopping = false;
  constructor(private readonly command: string, private readonly args: string[], private readonly log: (message: string) => void = console.error) {}

  start(): Promise<void> {
    if (this.starting) return this.starting;
    this.stopping = false;
    this.ready = false;
    this.reason = 'The local translation model is loading.';
    this.starting = new Promise<void>((resolve, reject) => {
      const child = spawn(this.command, this.args, { stdio: ['pipe', 'pipe', 'pipe'], env: workerEnvironment(), windowsHide: true });
      this.child = child;
      let buffer = '', initialized = false;
      const timeout = setTimeout(() => fail(new Error('Model initialization timed out')), 30 * 60_000);
      timeout.unref();
      const fail = (_error: Error) => {
        this.ready = false;
        this.reason = 'The local translation worker failed. Check runtime prerequisites and model cache, then restart the app.';
        this.pending?.reject(new ProviderError('translation_worker_failed', 'The local translation worker stopped.', 503));
        this.pending = undefined;
        if (!initialized) reject(new Error(this.reason));
        child.kill('SIGKILL');
      };
      this.closed = new Promise<void>(done => child.once('close', () => {
        clearTimeout(timeout);
        if (this.child === child) { this.child = undefined; this.starting = undefined; this.ready = false; }
        if (!this.stopping) fail(new Error('Worker exited'));
        else if (!initialized) reject(new Error('Worker stopped during initialization'));
        done();
      }));
      child.once('error', fail);
      child.stdin.on('error', fail);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 2_097_152) { fail(new Error('Worker output exceeded its limit')); return; }
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          try {
            const value: unknown = JSON.parse(line);
            if (!initialized) {
              if (!value || typeof value !== 'object' || !('ready' in value) || value.ready !== true) throw new Error('Invalid startup message');
              initialized = true; clearTimeout(timeout); this.ready = true; this.reason = undefined; resolve();
            } else {
              const pending = this.pending;
              if (!pending) throw new Error('Unexpected worker response');
              this.pending = undefined; pending.resolve(value);
            }
          } catch { fail(new Error('Invalid worker protocol')); }
        }
      });
      // Only fixed phase messages and exception class names are safe to expose in app logs.
      let diagnostic = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        diagnostic = (diagnostic + chunk).slice(-8192);
        let end: number;
        while ((end = diagnostic.indexOf('\n')) >= 0) {
          const line = diagnostic.slice(0, end).trim(); diagnostic = diagnostic.slice(end + 1);
          if (['OPUS phase: verified cache.', 'OPUS phase: converting INT8 weights.', 'Downloading the pinned OPUS-MT Big model (889 MB).'].includes(line)
            || /^OPUS worker stopped: [A-Za-z]{1,60}$/.test(line)) this.log(line);
        }
      });
    });
    return this.starting;
  }

  async translate(texts: string[], signal: AbortSignal): Promise<string[]> {
    signal.throwIfAborted();
    if (!this.ready || !this.child) throw new ProviderError('translation_not_ready', this.reason ?? 'The model is loading.', 503);
    if (this.pending) throw new ProviderError('translation_busy', 'Local translation is busy.', 429);
    const child = this.child;
    const abort = () => {
      this.pending?.reject(signal.reason instanceof Error ? signal.reason : new Error('Translation cancelled'));
      this.pending = undefined;
      this.ready = false;
      this.reason = 'The local translation worker is restarting after cancellation.';
      child.kill('SIGKILL');
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      const value = await new Promise<unknown>((resolve, reject) => {
        this.pending = { resolve, reject };
        child.stdin.write(JSON.stringify({ texts }) + '\n');
        if (signal.aborted) abort();
      });
      if (!value || typeof value !== 'object') throw new Error('Invalid worker response');
      if ('error' in value) {
        const code = value.error === 'translation_segment_too_large' ? 'translation_segment_too_large' : 'translation_failed';
        throw new ProviderError(code, code === 'translation_segment_too_large' ? 'A prose fragment exceeds the 512-token model limit; shorten that sentence.' : 'The local model could not translate this fragment.', code === 'translation_segment_too_large' ? 413 : 502);
      }
      if (!('translations' in value) || !Array.isArray(value.translations) || value.translations.length !== texts.length || value.translations.some(v => typeof v !== 'string'))
        throw new ProviderError('translation_result_invalid', 'The worker returned incomplete translation output.', 502);
      return value.translations as string[];
    } finally {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) {
        await this.closed;
        if (!this.stopping) void this.start().catch(() => this.log('OPUS worker recovery failed. Restart the app.'));
      }
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.ready = false;
    this.pending?.reject(new ProviderError('translation_unavailable', 'The app is stopping.', 503));
    this.pending = undefined;
    this.child?.kill('SIGKILL');
    await this.closed;
  }
}
