import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function sdkVersion(globalJson) {
  const version = globalJson?.sdk?.version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*)?$/.test(version)) {
    throw new Error('global.json must declare an exact .NET SDK version.');
  }
  return version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const source = path.join(process.env.GITHUB_WORKSPACE || process.cwd(), 'global.json');
  const version = sdkVersion(JSON.parse(readFileSync(source, 'utf8')));
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
}
