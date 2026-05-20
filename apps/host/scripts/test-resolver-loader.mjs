import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const hostRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const srcRoot = path.join(hostRoot, 'src');
const extensions = ['', '.ts', '.tsx', '.mts', '.mjs', '.js'];

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'next/server') {
    return nextResolve('next/server.js', context);
  }

  if (specifier.startsWith('@/')) {
    const target = resolveExistingPath(path.join(srcRoot, specifier.slice(2)));
    if (target) {
      return {
        url: pathToFileURL(target).href,
        shortCircuit: true,
      };
    }
  }

  return nextResolve(specifier, context);
}

function resolveExistingPath(basePath) {
  for (const extension of extensions) {
    const candidate = `${basePath}${extension}`;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }

  for (const extension of extensions) {
    const candidate = path.join(basePath, `index${extension}`);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }

  return null;
}
