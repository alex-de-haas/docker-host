import { posix } from 'node:path';
function relativePath(value) {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\')
    || value.split('/').some(x => !x || x === '.' || x === '..') || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`Unsafe repository path: ${value}`);
  return value;
}

/** Keep the lock's actual installation paths, optional platforms and peer closure. Nothing is re-resolved. */
export function projectNpm(rootPackage, lock, initialWorkspaces, { ignoreOptionalPeers = false } = {}) {
  if (lock.lockfileVersion !== 3 || !lock.packages?.['']) throw new Error('A complete npm lockfileVersion 3 is required.');
  const packages = lock.packages, included = new Set(['']), workspaces = new Set(initialWorkspaces), queue = [...initialWorkspaces];
  const resolveDependency = (from, name) => {
    if (!/^(?:@[^/]+\/)?[^/]+$/.test(name)) throw new Error(`Invalid dependency name ${name}`);
    let directory = from;
    while (true) {
      const candidate = posix.join(directory, 'node_modules', name);
      if (Object.hasOwn(packages, candidate)) return candidate;
      if (!directory) return null;
      directory = posix.dirname(directory); if (directory === '.') directory = '';
    }
  };
  // Root dependencies/overrides/engines can influence every workspace. Do not discard them.
  queue.push('');
  const visited = new Set();
  while (queue.length) {
    const path = queue.shift(); if (visited.has(path)) continue; visited.add(path); included.add(path);
    const entry = packages[path]; if (!entry) throw new Error(`Missing locked workspace/dependency: ${path}`);
    if (entry.link) {
      relativePath(entry.resolved); workspaces.add(entry.resolved); queue.push(entry.resolved); continue;
    }
    if (entry.inBundle) {
      const parent = path.slice(0, path.lastIndexOf('/node_modules/'));
      if (!packages[parent]?.integrity && !packages[parent]?.inBundle) throw new Error(`Unpinned bundled package: ${path}`);
      queue.push(parent);
    }
    if (path.includes('node_modules/') && !entry.inBundle && (!entry.integrity || !/^https:\/\//.test(entry.resolved ?? ''))) {
      throw new Error(`Dependency has no integrity-pinned HTTPS archive: ${path}`);
    }
    const dependencies = { ...entry.dependencies, ...entry.optionalDependencies, ...entry.peerDependencies,
      ...(!path.includes('node_modules/') ? entry.devDependencies : {}) };
    for (const name of Object.keys(dependencies)) {
      if (ignoreOptionalPeers && entry.peerDependenciesMeta?.[name]?.optional
        && !Object.hasOwn(entry.dependencies ?? {}, name) && !Object.hasOwn(entry.optionalDependencies ?? {}, name)
        && !Object.hasOwn(entry.devDependencies ?? {}, name)) continue;
      const target = resolveDependency(path, name);
      if (target) queue.push(target);
      else if (!Object.hasOwn(entry.optionalDependencies ?? {}, name) && !entry.peerDependenciesMeta?.[name]?.optional) {
        throw new Error(`Cannot prove locked dependency closure for ${path || '<root>'}: ${name}`);
      }
    }
  }
  // npm links each selected workspace, even when it is only an explicit --workspace target.
  for (const [path, entry] of Object.entries(packages)) if (entry.link && workspaces.has(entry.resolved)) included.add(path);
  const projectedPackage = { ...rootPackage, workspaces: [...workspaces].sort() };
  delete projectedPackage.scripts; // All release Dockerfiles invoke workspace scripts directly.
  const projectedLock = { ...lock, packages: Object.fromEntries([...included].sort().map(path => [path, packages[path]])) };
  projectedLock.packages[''] = { ...packages[''], workspaces: projectedPackage.workspaces };
  return { package: projectedPackage, lock: projectedLock, workspaces: [...workspaces].sort() };
}
