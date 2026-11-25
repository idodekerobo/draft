export async function afterMcpRestored<T>(restore: () => Promise<void>, recover: () => Promise<T> | T): Promise<T> {
  await restore();
  return recover();
}

export function watchMcpWake(recover: () => Promise<unknown>, now = Date.now): () => void {
  let last = now();
  const timer = setInterval(() => {
    const current = now();
    const overslept = current - last > 30_000;
    last = current;
    if (overslept) void recover().catch(() => {});
  }, 5_000);
  timer.unref();
  return () => clearInterval(timer);
}
