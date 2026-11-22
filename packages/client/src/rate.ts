/**
 * Speed and time left for a long job (zipping, uploading, deleting): fed the running total,
 * it smooths the rate over the last few seconds so the estimate doesn't jump about.
 */
export class RateMeter {
  private last: { t: number; done: number } | null = null;
  private current: number | null = null;

  constructor(private readonly clock: () => number = () => Date.now(), private readonly smoothing = 0.3) {}

  /** Units per second so far; null until there are two readings at least half a second apart. */
  sample(done: number): number | null {
    const t = this.clock();
    if (!this.last || done < this.last.done) {
      this.last = { t, done };
      this.current = null;
      return null;
    }
    const seconds = (t - this.last.t) / 1000;
    if (seconds < 0.5) return this.current;
    const r = (done - this.last.done) / seconds;
    this.current = this.current === null ? r : this.current + this.smoothing * (r - this.current);
    this.last = { t, done };
    return this.current;
  }

  get rate(): number | null {
    return this.current;
  }

  /** Seconds left at the current rate, or null when there's no rate yet. */
  eta(done: number, total: number): number | null {
    if (!this.current || this.current <= 0 || !total) return null;
    return Math.max(0, Math.round((total - done) / this.current));
  }
}

/** "1 h 4 min", "3 min", "40 s". */
export function formatEta(seconds: number): string {
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)} h ${Math.round((seconds % 3600) / 60)} min`;
  if (seconds >= 90) return `${Math.round(seconds / 60)} min`;
  return `${Math.max(1, Math.round(seconds))} s`;
}

/** "123.8 GB", "640 MB", "12 KB". */
export function formatSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * One status line for a long job: "Zipping the installed game: 45% (55.7 GB of 123.8 GB,
 * 1,234 of 20,000 files) · 210.0 MB/s · about 6 min left".
 */
export function progressLine(
  label: string,
  p: { done: number; total: number; unit?: "bytes" | "files"; files?: number; totalFiles?: number; rate?: number | null; etaSeconds?: number | null },
): string {
  if (!p.total) return label;
  const pct = Math.min(100, Math.floor((p.done / p.total) * 100));
  const count = (n: number) => n.toLocaleString("en-US");
  const amounts =
    p.unit === "files"
      ? `${count(p.done)} of ${count(p.total)} files`
      : `${formatSize(p.done)} of ${formatSize(p.total)}${p.totalFiles ? `, ${count(p.files ?? 0)} of ${count(p.totalFiles)} files` : ""}`;
  const parts = [`${label}: ${pct}% (${amounts})`];
  if (p.rate && p.rate > 0) parts.push(p.unit === "files" ? `${Math.round(p.rate)} files/s` : `${formatSize(p.rate)}/s`);
  if (p.etaSeconds !== null && p.etaSeconds !== undefined && p.done < p.total) parts.push(`about ${formatEta(p.etaSeconds)} left`);
  return parts.join(" · ");
}
