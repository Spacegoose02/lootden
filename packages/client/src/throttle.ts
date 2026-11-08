import { Transform } from "node:stream";

/**
 * A shared download speed limit: every download on the PC takes bytes from one bucket, so
 * two games downloading at once share the limit instead of each getting it. The limit is read
 * each time, so changing it in settings applies to downloads already running.
 */
export class RateLimiter {
  private tokens = 0;
  private last: number;

  constructor(
    /** Bytes a second; 0 or less is no limit. */
    private readonly bytesPerSecond: () => number,
    private readonly clock: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.last = clock();
  }

  limit(): number {
    const n = this.bytesPerSecond();
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  /** Waits until `bytes` may go through. */
  async take(bytes: number): Promise<void> {
    for (;;) {
      const rate = this.limit();
      if (!rate) return;
      const t = this.clock();
      // At most a second's worth saved up, so a pause doesn't allow a burst afterwards.
      this.tokens = Math.min(rate, this.tokens + ((t - this.last) / 1000) * rate);
      this.last = t;
      // A chunk larger than a second's worth goes through once the bucket is full.
      const need = Math.min(bytes, rate);
      if (this.tokens >= need) {
        this.tokens -= need;
        return;
      }
      await this.sleep(Math.max(10, Math.ceil(((need - this.tokens) / rate) * 1000)));
    }
  }

  /** A pass-through stream that holds chunks back to keep under the limit. */
  stream(): Transform {
    return new Transform({
      transform: (chunk: Buffer, _enc, done) => {
        this.take(chunk.length).then(
          () => done(null, chunk),
          (err: Error) => done(err),
        );
      },
    });
  }
}

/** "HH:MM" to minutes after midnight, or null. */
export function clockMinutes(s: unknown): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

/** Whether `at` falls in a daily window; a window that ends before it starts runs past midnight. */
export function inWindow(window: { from: string; to: string } | null | undefined, at: Date): boolean {
  if (!window) return true;
  const from = clockMinutes(window.from);
  const to = clockMinutes(window.to);
  if (from === null || to === null || from === to) return true;
  const now = at.getHours() * 60 + at.getMinutes();
  return from < to ? now >= from && now < to : now >= from || now < to;
}
