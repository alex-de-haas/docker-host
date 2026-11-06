import { mkdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const cache = process.env.HOSTY_APP_CACHE_DIR;
if (!cache) throw new Error('Hosty app cache directory is required.');
const root = resolve(cache);
await mkdir(root, { recursive: true });
const environment = join(root, 'python');
const python = join(environment, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const env = { ...process.env, UV_CACHE_DIR: join(root, 'uv'), UV_PYTHON_INSTALL_DIR: join(root, 'python-install') };
const run = args => execFileSync('uv', args, { env, stdio: 'inherit', timeout: 600_000 });
// uv and Node are operator-installed prerequisites; Python and its packages belong to this app cache.
try { await readFile(join(environment, 'pyvenv.cfg')); }
catch { run(['venv', '--python', '3.13', '--managed-python', environment]); }
run(['pip', 'sync', '--python', python, '--require-hashes', fileURLToPath(new URL('../runtime/requirements.lock', import.meta.url))]);
