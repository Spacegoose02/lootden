import { readFile } from "node:fs/promises";
import path from "node:path";
import { PC_PLATFORM } from "@lootden/shared";
import type { Notifier } from "../alerts/notifier.js";
import type { Library } from "../catalog/library.js";
import { releaseVersion } from "../connectors/tidy.js";
import { now, type Db } from "../db/database.js";
import { titleKey } from "../metadata/calendar.js";
import { cleanTitle } from "../metadata/titles.js";
import type { FetchLike } from "../metadata/http.js";
import type { GameUpdates } from "./updates.js";

export interface VersionCheck {
  gameId: string;
  /** The version in the game's file or folder name ("Title v1.2.zip"), if any. */
  current: string | null;
  latest: string | null;
  source: "gog" | "steam" | "itch" | null;
  /** A sentence on what was compared. */
  detail: string | null;
  url: string | null;
  behind: boolean;
  checkedAt: string;
}

/** -1, 0 or 1, comparing dotted numbers ("1.10.2" > "1.9"); builds compare as numbers. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^build\s*/i, "").split(/[._-]/).map((x) => parseInt(x, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** The first version number in a patch-notes title: "Patch 1.2.3 is live" -> "1.2.3". */
export function versionIn(text: string): string | null {
  return text.match(/(?<![\d.])v?(\d+\.\d+(?:\.\d+){0,2})(?![\d.])/i)?.[1] ?? null;
}

const UA = { "User-Agent": "Mozilla/5.0 (LootDen)" };

/**
 * Notices games that are behind: the version in the file name (LootDen names imports
 * "Title v1.2.zip") against GOG's current installer, the itch.io upload, or Steam patch notes.
 */
export class VersionChecker {
  private running: Promise<void> | null = null;

  constructor(
    private readonly db: Db,
    private readonly library: Library,
    private readonly news: GameUpdates,
    private readonly notifier: Notifier,
    private readonly itchKey: () => string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  get(gameId: string): VersionCheck | null {
    const r = this.db.prepare("SELECT * FROM game_updates WHERE game_id = ?").get(gameId) as Record<string, unknown> | undefined;
    return r ? this.row(r) : null;
  }

  behind(): VersionCheck[] {
    return (this.db.prepare("SELECT * FROM game_updates WHERE behind = 1").all() as Array<Record<string, unknown>>).map((r) => this.row(r)).filter((c) => this.library.scannedGame(c.gameId));
  }

  private row(r: Record<string, unknown>): VersionCheck {
    return {
      gameId: String(r.game_id),
      current: (r.current as string | null) ?? null,
      latest: (r.latest as string | null) ?? null,
      source: (r.source as VersionCheck["source"]) ?? null,
      detail: (r.detail as string | null) ?? null,
      url: (r.url as string | null) ?? null,
      behind: r.behind === 1,
      checkedAt: String(r.checked_at),
    };
  }

  /** Checks one game and stores the answer; alerts when it newly falls behind. */
  async check(gameId: string): Promise<VersionCheck> {
    const scanned = this.library.scannedGame(gameId);
    const game = this.library.get(gameId);
    if (!scanned || !game) throw new Error("No such game");
    const current = releaseVersion(path.posix.basename(scanned.source));
    const result =
      (await this.itch(scanned.source, scanned.entryModifiedAt)) ??
      (await this.gog(game.metadata?.name ?? cleanTitle(path.posix.basename(scanned.source)).query, current)) ??
      (game.metadata?.steamAppId ? await this.steam(game.metadata.steamAppId, current, scanned.entryModifiedAt) : null);
    const check: VersionCheck = {
      gameId,
      current,
      latest: result?.latest ?? null,
      source: result?.source ?? null,
      detail: result?.detail ?? (current ? "No store to compare with" : "No version in the file name and no store to compare with"),
      url: result?.url ?? null,
      behind: result?.behind ?? false,
      checkedAt: now(),
    };
    const before = this.get(gameId);
    this.db
      .prepare(
        "INSERT INTO game_updates (game_id, current, latest, source, detail, url, behind, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(game_id) DO UPDATE SET current = excluded.current, latest = excluded.latest, source = excluded.source, detail = excluded.detail, url = excluded.url, behind = excluded.behind, checked_at = excluded.checked_at",
      )
      .run(gameId, check.current, check.latest, check.source, check.detail, check.url, check.behind ? 1 : 0, check.checkedAt);
    this.library.storeVersionChanged();
    if (check.behind && (!before?.behind || before.latest !== check.latest)) {
      await this.notifier.send("updates", `${game.title} has an update`, check.detail, `/games/${gameId}`);
    }
    return check;
  }

  /** Games added from itch.io keep a note of the upload; a newer upload means an update. */
  private async itch(source: string, entryModifiedAt: string) {
    const key = this.itchKey();
    const note = await readFile(path.join(this.library.gamesDir, source, ".itch.json"), "utf8").then((t) => JSON.parse(t) as { gameId: number; uploadId: number; updatedAt?: string; url?: string }, () => null);
    if (!note || !key) return null;
    const res = await this.fetchImpl(`https://api.itch.io/games/${note.gameId}/uploads`, { headers: { ...UA, Authorization: `Bearer ${key}` } });
    if (!res.ok) return null;
    const uploads = ((await res.json()) as { uploads?: Array<{ id: number; updated_at?: string; build?: { user_version?: string; version?: number } }> }).uploads ?? [];
    const up = uploads.find((u) => u.id === note.uploadId);
    if (!up) return null;
    const latest = up.build?.user_version ?? (up.build?.version != null ? `Build ${up.build.version}` : (up.updated_at?.slice(0, 10) ?? null));
    const newer = !!up.updated_at && Date.parse(up.updated_at) > Date.parse(note.updatedAt ?? entryModifiedAt);
    return { source: "itch" as const, latest, behind: newer, url: note.url ?? null, detail: newer ? `itch.io has a newer upload (${latest})` : "Same upload as itch.io" };
  }

  /** GOG lists the current installer version for each game. */
  private async gog(title: string, current: string | null) {
    if (!current) return null;
    const search = await this.fetchImpl(`https://embed.gog.com/games/ajax/filtered?mediaType=game&search=${encodeURIComponent(title)}`, { headers: UA }).catch(() => null);
    if (!search?.ok) return null;
    const products = ((await search.json()) as { products?: Array<{ id: number; title: string; url?: string }> }).products ?? [];
    const match = products.find((p) => titleKey(p.title) === titleKey(title));
    if (!match) return null;
    const res = await this.fetchImpl(`https://api.gog.com/products/${match.id}?expand=downloads`, { headers: UA }).catch(() => null);
    if (!res?.ok) return null;
    const installers = ((await res.json()) as { downloads?: { installers?: Array<{ os: string; version: string | null }> } }).downloads?.installers ?? [];
    const latest = installers.find((i) => i.os === "windows" && i.version)?.version ?? installers.find((i) => i.version)?.version ?? null;
    if (!latest) return null;
    const behind = compareVersions(latest, current) > 0;
    return { source: "gog" as const, latest, behind, url: match.url ? `https://www.gog.com${match.url}` : null, detail: behind ? `GOG has v${latest}; this copy is v${current}` : `Up to date with GOG (v${latest})` };
  }

  /** Steam has no version field; patch notes newer than this copy (or with a higher number) count. */
  private async steam(appId: string, current: string | null, entryModifiedAt: string) {
    const notes = (await this.news.forSteamApp(appId).catch(() => [])).filter((n) => n.patchNotes);
    const newest = notes[0];
    if (!newest) return null;
    const latest = notes.map((n) => versionIn(n.title)).find(Boolean) ?? null;
    const behind = current && latest ? compareVersions(latest, current) > 0 : Date.parse(newest.date) > Date.parse(entryModifiedAt) + 86400_000;
    return {
      source: "steam" as const,
      latest,
      behind,
      url: newest.url,
      detail: behind ? `Steam posted "${newest.title}" after this copy` : "No Steam patch notes newer than this copy",
    };
  }

  /** The daily pass over PC games, one at a time. */
  run(maxAgeHours = 24): Promise<void> {
    this.running ??= (async () => {
      const cutoff = Date.now() - maxAgeHours * 3600_000;
      for (const g of this.library.list({ platform: PC_PLATFORM })) {
        const last = this.get(g.id);
        if (last && Date.parse(last.checkedAt) > cutoff) continue;
        await this.check(g.id).catch(() => null);
        await new Promise((r) => setTimeout(r, Number(process.env.GM_WANTED_DELAY_MS ?? 1500)));
      }
    })().finally(() => (this.running = null));
    return this.running;
  }
}
