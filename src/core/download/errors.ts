/**
 * Shared provider-failure type (plan Task 4).
 *
 * `reason` is a stable machine string the queue, the API and the UI key on:
 * `cookie-expired`, `no-confident-match`, `timeout`, `cancelled`, `rate-limit`
 * and `io-error` today, plus the yt-dlp reasons the YouTube source work adds. A
 * provider throws this to name its failure; the queue also honours anything
 * else carrying a string `reason` property (`reasonOf` in `queue.ts`).
 *
 * It lives beside the other download types rather than inside a provider so the
 * queue never has to import a provider module just to name an error.
 */

export class DownloadFailure extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = 'DownloadFailure';
    this.reason = reason;
  }
}
