let moduleMutationMutex: Promise<void> = Promise.resolve();

export async function withModuleMutationLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = moduleMutationMutex;
  let release: () => void = () => undefined;
  moduleMutationMutex = new Promise<void>(resolve => {
    release = resolve;
  });

  await previous;

  try {
    return await operation();
  } finally {
    release();
  }
}
