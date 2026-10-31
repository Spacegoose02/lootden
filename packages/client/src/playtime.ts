import { computeAllowance, secondsLeft, zonedParts, type Allowance, type PlayLimits } from "@lootden/shared";

/** What the server says about today, as the desktop app keeps it for when it's offline. */
export interface KeptAllowance {
  allowance: Allowance;
  limits: PlayLimits;
  /** When it was fetched. */
  at: string;
}

/**
 * Today's allowance while the server can't be reached: the last one kept, with play time
 * recorded since then added on. A new day starts from nothing, with no bonus time.
 */
export function offlineAllowance(kept: KeptAllowance, pending: Array<{ seconds: number; playedAt: string }>, now = new Date()): Allowance {
  const tz = kept.allowance.timeZone;
  const today = zonedParts(now, tz).date;
  const sameDay = kept.allowance.date === today;
  const since = pending.filter((p) => p.playedAt > kept.at && zonedParts(new Date(p.playedAt), tz).date === today).reduce((n, p) => n + p.seconds, 0);
  return computeAllowance(kept.limits, (sameDay ? kept.allowance.usedSeconds : 0) + since, sameDay ? kept.allowance.bonusSeconds : 0, now, tz);
}

export interface PlayWatchOptions {
  /** Today's allowance when the game started. */
  allowance: Allowance;
  /** Asked again now and then, so bonus time granted mid-game counts; null keeps the last one. */
  refresh: () => Promise<Allowance | null>;
  /** A heads-up: minutes left. */
  onWarn: (minutesLeft: number) => void;
  /** Time ran out (or it's bedtime). `closingIn` is the grace in seconds when the game will be closed. */
  onTimeUp: (closingIn: number | null) => void;
  /** Close the game (hard stop only). */
  onStop: () => void;
  /** Seconds between checks and between asking the server again. */
  tickSeconds?: number;
  refreshSeconds?: number;
  /** Time to save before a hard stop closes the game. */
  graceSeconds?: number;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (t: unknown) => void;
}

/** Heads-ups at 10, 5 and 1 minute left. */
const WARN_AT = [10, 5, 1];

/**
 * Watches a running game against today's play time and bedtime: heads-ups as the end gets
 * close, then time's up, and with a hard stop the game is closed after a minute to save.
 * Returns a function that stops watching (call it when the game exits).
 */
export function watchPlayTime(o: PlayWatchOptions): () => void {
  const now = o.now ?? Date.now;
  const tick = (o.tickSeconds ?? 20) * 1000;
  const refreshEvery = (o.refreshSeconds ?? 120) * 1000;
  const grace = o.graceSeconds ?? 60;
  const started = now();
  // When play has to end, as a timestamp: the allowance doesn't include the session still running.
  const deadlineFrom = (a: Allowance, at: number): number | null => {
    const left = secondsLeft({ ...a, remainingSeconds: a.remainingSeconds === null ? null : a.remainingSeconds - (at - started) / 1000 });
    return left === null ? null : at + left * 1000;
  };
  let deadline = deadlineFrom(o.allowance, started);
  let hardStop = o.allowance.hardStop;
  let lastRefresh = started;
  let warned = new Set<number>();
  let upAt: number | null = null;
  let stopped = false;
  let refreshing = false;

  const check = () => {
    if (stopped) return;
    const t = now();
    if (t - lastRefresh >= refreshEvery && !refreshing) {
      refreshing = true;
      lastRefresh = t;
      void o
        .refresh()
        .then((a) => {
          if (!a || stopped) return;
          const next = deadlineFrom(a, now());
          hardStop = a.hardStop;
          // More time (bonus granted): the heads-ups start over.
          if (deadline !== null && (next === null || next > deadline + 30_000)) {
            warned = new Set();
            upAt = null;
          }
          deadline = next;
        })
        .catch(() => {})
        .finally(() => (refreshing = false));
    }
    if (deadline === null) return;
    const left = (deadline - t) / 1000;
    if (left > 0) {
      const due = WARN_AT.filter((m) => left <= m * 60 && !warned.has(m));
      if (due.length) {
        for (const m of WARN_AT) if (left <= m * 60) warned.add(m);
        o.onWarn(Math.max(1, Math.ceil(left / 60)));
      }
      return;
    }
    if (upAt === null) {
      upAt = t;
      o.onTimeUp(hardStop ? grace : null);
    } else if (hardStop && t - upAt >= grace * 1000) {
      stopped = true;
      o.onStop();
    }
  };
  const timer = (o.setInterval ?? setInterval)(check, tick);
  check();
  return () => {
    stopped = true;
    (o.clearInterval ?? ((x) => clearInterval(x as ReturnType<typeof setInterval>)))(timer);
  };
}
