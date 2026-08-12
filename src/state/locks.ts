const pending = new Map<string, Promise<void>>();

/** Serializes read/hash/approval/write sequences for one local resource. */
export async function withWriteLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = pending.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  pending.set(key, queued);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (pending.get(key) === queued) pending.delete(key);
  }
}
