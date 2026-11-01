import { randomBytes } from "node:crypto";
import { compareVersion, PC_PLATFORM, type GameDetail, type RefreshCandidate, type RefreshJob } from "@lootden/shared";
import type { Library } from "./library.js";
import type { PresenceService } from "../users/presence.js";

/** A PC that hasn't picked up a refresh in a day (switched off) gives up. */
const WAIT_MS = 86400_000;

/**
 * Refreshing the library copy from a PC: when a household PC has a newer copy of a game than
 * the server (updated by its own launcher, or by applying the server's updates), an admin asks
 * that PC to zip its install and upload it. The upload replaces the library copy, and the
 * updates and older full copies it makes unnecessary move to .replaced/ in the games folder.
 *
 * The PC uploads with a one-time ticket, so it doesn't need an admin profile signed in.
 */
export class LibraryRefresh {
  private readonly jobs = new Map<string, RefreshJob & { at: number }>();
  /** Called when a job moves on, so open pages fetch again. */
  onChange: () => void = () => {};

  constructor(
    private readonly library: Library,
    private readonly presence: PresenceService,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Library games a PC has a newer copy of, with what a refresh would clear out. */
  candidates(): RefreshCandidate[] {
    const byGame = new Map<string, RefreshCandidate["pcs"]>();
    for (const pc of this.presence.copiesByPc()) {
      for (const c of pc.copies) byGame.set(c.gameId, [...(byGame.get(c.gameId) ?? []), { device: pc.device, version: c.version, fromExe: !!c.fromExe, online: pc.online }]);
    }
    const out: RefreshCandidate[] = [];
    for (const [gameId, all] of byGame) {
      const game = this.library.get(gameId, false);
      if (!game || game.kind !== "game" || game.platform !== PC_PLATFORM) continue;
      const pcs = all.filter((p) => newer(p.version, game)).sort((a, b) => compareVersion(b.version, a.version) || Number(b.online) - Number(a.online));
      if (!pcs.length) continue;
      const plan = this.library.refreshPlan(gameId, pcs[0]!.version)!;
      // A library copy with no version of its own only counts as behind when updates say so.
      if (!game.version && !plan.updates.length) continue;
      const brief = (g: GameDetail) => ({ id: g.id, title: g.title, version: g.version, sizeBytes: g.sizeBytes });
      out.push({
        gameId,
        title: game.title,
        coverUrl: game.coverUrl,
        libraryVersion: game.version,
        latestVersion: game.latestVersion,
        updates: plan.updates.map(brief),
        oldCopies: plan.oldCopies.map(brief),
        sizeBytes: game.sizeBytes,
        pcs,
      });
    }
    return out.sort((a, b) => a.title.localeCompare(b.title));
  }

  /** Refreshes started in the last day, newest first. */
  list(): RefreshJob[] {
    this.expire();
    return [...this.jobs.values()].sort((a, b) => b.at - a.at).map(({ at: _a, ...j }) => j);
  }

  /** Admin: ask a PC to upload its copy of a game. */
  start(gameId: string, device: string, from: string): RefreshJob {
    this.expire();
    const game = this.library.get(gameId, false);
    if (!game) throw new Error("No such game");
    const busy = [...this.jobs.values()].find((j) => j.gameId === gameId && (j.state === "waiting" || j.state === "uploading"));
    if (busy) throw new Error(`${busy.device} is already uploading ${game.title}`);
    const copy = this.presence.copiesByPc().find((p) => p.device === device)?.copies.find((c) => c.gameId === gameId);
    if (!copy) throw new Error(`${device} doesn't have ${game.title} installed`);
    if (!newer(copy.version, game)) throw new Error(`${device}'s copy (v${copy.version}) isn't newer than the library's`);
    const ticket = randomBytes(24).toString("base64url");
    this.presence.send(device, from, { kind: "refresh-copy", gameId, title: game.title, version: copy.version, ticket });
    const job = { ticket, gameId, title: game.title, device, version: copy.version, state: "waiting" as const, message: null, startedAt: new Date(this.clock()).toISOString(), newGameId: null, at: this.clock() };
    this.jobs.set(ticket, job);
    this.onChange();
    const { at: _a, ...out } = job;
    return out;
  }

  /** The job a ticket belongs to, while its upload may still arrive. */
  open(ticket: string | undefined, gameId: string): RefreshJob | null {
    this.expire();
    const job = ticket ? this.jobs.get(ticket) : undefined;
    if (!job || job.gameId !== gameId || (job.state !== "waiting" && job.state !== "uploading")) return null;
    return job;
  }

  /** The PC started sending its zip. */
  uploading(ticket: string): void {
    const job = this.jobs.get(ticket);
    if (job && job.state === "waiting") {
      job.state = "uploading";
      this.onChange();
    }
  }

  /** The new copy is in the library: move out what it makes unnecessary. */
  async finish(ticket: string, game: GameDetail, cleared: string[]): Promise<void> {
    const job = this.jobs.get(ticket);
    if (!job) return;
    job.state = "done";
    job.newGameId = game.id;
    job.message = cleared.length ? `Moved to .replaced: ${cleared.join(", ")}` : null;
    this.onChange();
  }

  /** The PC couldn't do it (game running, not installed any more, upload failed). */
  fail(ticket: string, message: string): void {
    const job = this.jobs.get(ticket);
    if (!job || job.state === "done") return;
    job.state = "failed";
    job.message = String(message || "The PC couldn't upload it").slice(0, 300);
    this.onChange();
  }

  private expire(): void {
    const t = this.clock();
    for (const [ticket, job] of this.jobs) {
      if (job.state === "waiting" && t - job.at > WAIT_MS) {
        job.state = "failed";
        job.message = `${job.device} didn't come on within a day`;
      }
      if (t - job.at > 7 * WAIT_MS) this.jobs.delete(ticket);
    }
  }
}

/** A PC's version is worth a refresh: newer than the library copy, and at least the newest update. */
function newer(version: string, game: GameDetail): boolean {
  if (game.version && compareVersion(version, game.version) <= 0) return false;
  if (game.latestVersion && compareVersion(version, game.latestVersion) < 0) return false;
  return !!(game.version || game.latestVersion);
}
