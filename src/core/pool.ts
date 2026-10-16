/**
 * Bounded concurrency.
 *
 * This lives in its own module because both the scanner and the batch renderer
 * need it, and `batch.ts` already imports `library.ts` — putting the pool in
 * either one would turn that dependency into a cycle.
 */

import { cpus } from 'node:os';

/** Device-safe ceiling for the default. See `defaultConcurrency`. */
export const MAX_DEFAULT_CONCURRENCY = 4;

/**
 * How many children to run at once by default.
 *
 * `cpus().length - 1` is the right answer for work that is CPU-bound and writes
 * to a real disk. It is the wrong answer for the job this tool exists for:
 * rendering many small files onto one USB stick.
 *
 * Measured on a 16-core machine against a single FAT32 stick, the stock
 * `cpus - 1` default opened 15 concurrent ffmpeg writers. Twelve seconds of
 * sampling moved the staging files only 11.5 MiB in total — roughly 1 MiB/s
 * across the whole batch — and the run looked hung. It was not hung: fifteen
 * writers were taking turns thrashing one flash controller. The encoder is never
 * the bottleneck here; the device is.
 *
 * Four writers keeps the cores busy without stampeding the media. A caller that
 * knows it is writing to a fast SSD — or a scratch disk — can pass more.
 */
export function defaultConcurrency(): number {
  return Math.max(1, Math.min(MAX_DEFAULT_CONCURRENCY, cpus().length - 1));
}

/**
 * Run `fn` over every item with at most `limit` in flight.
 *
 * Results come back in **input order**, not completion order, so callers keep a
 * stable ordering even when the work finishes out of order.
 */
export async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const size = Math.max(1, Math.min(Math.max(1, Math.floor(limit)), items.length));
  const workers = Array.from({ length: size }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}
