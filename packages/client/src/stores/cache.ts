import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LocalStoreGame } from "@lootden/shared";
import type { StoreScanOptions } from "./index.js";

interface Entry {
  key: string;
  at: number;
  games: LocalStoreGame[];
}

export interface StoreGamesCacheOptions {
  /** Looks through this PC's launchers (scanStoreGames with the PC's settings). */
  scan: (opts: StoreScanOptions) => Promise<LocalStoreGame[]>;
  /** Where the last scan is kept between runs of the app; null keeps it in memory only. */
  file: string | null;
  /** How old a scan may be before a lookup starts a new one in the background. Default a minute. */
  maxAgeMs?: number;
  /** A background scan found something different (a game installed or removed). */
  onUpdate?: (games: LocalStoreGame[]) => void;
  clock?: () => number;
}

/** The settings a scan was made with: a scan with other launchers or folders doesn't count. */
const keyOf = (o: StoreScanOptions) => JSON.stringify({ disabled: [...(o.disabled ?? [])].sort(), folders: [...(o.folders ?? [])].sort() });
const same = (a: LocalStoreGame[], b: LocalStoreGame[]) => JSON.stringify(a) === JSON.stringify(b);

/**
 * This PC's store games (Steam, GOG, Epic...), kept between lookups and between runs of the app.
 * Reading every launcher's files takes a while, so a lookup answers from the last scan at once
 * and, when that's older than maxAgeMs, scans again in the background and reports changes
 * through onUpdate. Only the first lookup on a PC (or after its scan settings change) waits.
 */
export class StoreGamesCache {
  private entry: Entry | null = null;
  private loaded: Promise<void> | null = null;
  private scanning = new Map<string, Promise<LocalStoreGame[]>>();

  constructor(private readonly opts: StoreGamesCacheOptions) {}

  private now(): number {
    return this.opts.clock?.() ?? Date.now();
  }

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      if (!this.opts.file) return;
      try {
        const saved = JSON.parse(await readFile(this.opts.file, "utf8")) as Partial<Entry>;
        if (!this.entry && typeof saved.key === "string" && typeof saved.at === "number" && Array.isArray(saved.games)) this.entry = { key: saved.key, at: saved.at, games: saved.games };
      } catch {
        // No scan saved yet, or a damaged file: the first lookup scans.
      }
    })();
    return this.loaded;
  }

  private async save(entry: Entry): Promise<void> {
    if (!this.opts.file) return;
    await mkdir(path.dirname(this.opts.file), { recursive: true });
    const tmp = `${this.opts.file}.tmp`;
    await writeFile(tmp, JSON.stringify(entry));
    await rename(tmp, this.opts.file);
  }

  /**
   * The store games for these settings. Answers from the last scan when there is one (starting
   * a new scan in the background if it's older than maxAgeMs); otherwise waits for a scan.
   */
  async get(o: StoreScanOptions, maxAgeMs = this.opts.maxAgeMs ?? 60_000): Promise<LocalStoreGame[]> {
    await this.load();
    const key = keyOf(o);
    const e = this.entry;
    if (e && e.key === key) {
      if (this.now() - e.at > maxAgeMs) void this.refresh(o).catch(() => {});
      return e.games;
    }
    return this.refresh(o);
  }

  /** Scans now (one scan at a time per settings), keeps the result and reports a change. */
  refresh(o: StoreScanOptions): Promise<LocalStoreGame[]> {
    const key = keyOf(o);
    const running = this.scanning.get(key);
    if (running) return running;
    const job = (async () => {
      await this.load();
      const games = await this.opts.scan(o);
      const before = this.entry;
      const entry = { key, at: this.now(), games };
      this.entry = entry;
      await this.save(entry).catch(() => {});
      // Pages already showing the old list hear about the new one.
      if (before && (before.key !== key || !same(before.games, games))) this.opts.onUpdate?.(games);
      return games;
    })().finally(() => this.scanning.delete(key));
    this.scanning.set(key, job);
    return job;
  }
}
