import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit'], { cwd: root, stdio: 'inherit' });
await build({ absWorkingDir: root, entryPoints: ['src/main.ts'], bundle: true, platform: 'node', target: 'node24', format: 'esm', outfile: 'dist/main.mjs', logLevel: 'info' });
