/**
 * Borrows process-wide environment variables for the length of one test file.
 *
 * Suites configure the harness through `process.env` — the delegated-token public key, the app id,
 * a stub Core's origin — and `vitest.config.ts` records why that has to be undone: the variables
 * outlive the file that set them, and the next file then runs against a key it did not choose. But
 * undoing it by deleting is only right when the variable was ours to begin with. A developer who
 * exports one of these in their shell, or a CI job that sets it for the whole run, would have it
 * deleted out from under everything that follows. So the previous value is captured and put back,
 * and deletion is what "there was no previous value" restores to.
 *
 * @param values Variables to set, or `undefined` to only borrow one a test sets for itself later.
 * @returns The restore function, for `afterEach`.
 */
export function captureEnv(values: Record<string, string | undefined>): () => void {
  const previous = Object.entries(values).map(([name, value]) => {
    const before = process.env[name];
    if (value !== undefined) {
      process.env[name] = value;
    }
    return [name, before] as const;
  });

  return () => {
    for (const [name, before] of previous) {
      if (before === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = before;
      }
    }
  };
}
