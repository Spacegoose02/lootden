import { randomUUID } from "node:crypto";
import dgram from "node:dgram";
import {
  cleanMac,
  cleanPcMessage,
  magicPacket,
  PRESENCE_INTERVAL_SECONDS,
  PRESENCE_TIMEOUT_SECONDS,
  type NowPlaying,
  type PcCommand,
  type PcDisk,
  type PcInfo,
  type PlaySource,
  type PresenceAnswer,
  type PresenceReport,
  type RunningGame,
} from "@lootden/shared";
import type { Library } from "../catalog/library.js";
import { json, type Db } from "../db/database.js";
import type { UserRepo } from "./repo.js";
import type { FamilyService } from "./family.js";

interface Live {
  userId: number;
  device: string;
  game: RunningGame;
  lastSeen: number;
}

interface PcRow {
  name: string;
  macs: string;
  addresses: string;
  platform: string | null;
  app_version: string | null;
  disks: string;
  sunshine: number;
  moonlight: number;
  last_seen: string;
  last_user: number | null;
}

/** Sends a Wake-on-LAN packet; swapped out in tests. */
export type WakeSender = (packet: Uint8Array, addresses: string[]) => Promise<void>;

const SOURCES: PlaySource[] = ["lootden", "emulated", "roblox", "store"];
const MAX_GAMES_PER_PC = 8;

/** x.y.z.255 for each IPv4 address, and the all-hosts broadcast. */
export function broadcastAddresses(addresses: string[]): string[] {
  const out = new Set(["255.255.255.255"]);
  for (const a of addresses) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(a);
    if (m) out.add(`${m[1]}.${m[2]}.${m[3]}.255`);
  }
  return [...out];
}

const udpWake: WakeSender = (packet, addresses) =>
  new Promise((resolve, reject) => {
    const sock = dgram.createSocket("udp4");
    sock.once("error", (err) => {
      sock.close();
      reject(err);
    });
    sock.bind(() => {
      sock.setBroadcast(true);
      let left = addresses.length * 2;
      const done = () => {
        if (--left === 0) {
          sock.close();
          resolve();
        }
      };
      // Port 9 (discard) and 7 (echo) are the two network cards listen on.
      for (const addr of addresses) for (const port of [9, 7]) sock.send(packet, port, addr, done);
    });
  });

/**
 * Who is playing what, on which PC, kept in memory from the desktop apps' heartbeats; the PCs
 * themselves (for Wake-on-LAN and free space) are kept in the database. Parents' messages and
 * "close the game" wait here until that PC's next heartbeat.
 */
export class PresenceService {
  private readonly live = new Map<string, Live>();
  private readonly commands = new Map<string, Array<PcCommand & { at: number }>>();
  /** Called when what's playing changes, so open pages fetch again. */
  onChange: () => void = () => {};

  constructor(
    private readonly db: Db,
    private readonly users: UserRepo,
    private readonly library: Library,
    private readonly family: FamilyService,
    private readonly wake: WakeSender = udpWake,
    private readonly clock: () => number = Date.now,
  ) {}

  /** A heartbeat from a desktop app: what runs there now, and what it says about the PC. */
  report(userId: number, input: PresenceReport): PresenceAnswer {
    const device = String(input?.device ?? "").trim().slice(0, 100);
    if (!device) throw new Error("device is required");
    const t = this.clock();
    const games = (Array.isArray(input.playing) ? input.playing : []).slice(0, MAX_GAMES_PER_PC).flatMap((g) => {
      const gameId = String(g?.gameId ?? "").slice(0, 300);
      if (!gameId) return [];
      const started = Date.parse(String(g.startedAt));
      return [
        {
          gameId,
          title: String(g.title ?? "").trim().slice(0, 200) || "A game",
          source: SOURCES.includes(g.source) ? g.source : "lootden",
          store: typeof g.store === "string" ? g.store.slice(0, 40) : undefined,
          // Never in the future, never more than a day ago.
          startedAt: new Date(Number.isFinite(started) ? Math.min(t, Math.max(started, t - 86400_000)) : t).toISOString(),
        } satisfies RunningGame,
      ];
    });
    let changed = false;
    const seen = new Set<string>();
    for (const game of games) {
      const key = `${device}\n${game.gameId}`;
      seen.add(key);
      const before = this.live.get(key);
      if (!before || before.userId !== userId || before.game.title !== game.title) changed = true;
      this.live.set(key, { userId, device, game: before && before.userId === userId ? { ...game, startedAt: before.game.startedAt } : game, lastSeen: t });
    }
    // Games this PC no longer reports have stopped.
    for (const [key, l] of this.live) {
      if (l.device === device && !seen.has(key)) {
        this.live.delete(key);
        changed = true;
      }
    }
    this.savePc(device, userId, input.pc);
    if (changed) this.onChange();
    // Messages and closes go stale in ten minutes; Send to PC waits a day for the PC to come on.
    const queue = (this.commands.get(device) ?? []).filter((c) => t - c.at < (c.kind === "install" ? 86400_000 : 10 * 60_000));
    this.commands.delete(device);
    return { commands: queue.map(({ at: _at, ...c }) => c as PcCommand), nextInSeconds: PRESENCE_INTERVAL_SECONDS };
  }

  /** Drops games from PCs that went quiet (switched off, app closed, network gone). */
  private sweep(): void {
    const cutoff = this.clock() - PRESENCE_TIMEOUT_SECONDS * 1000;
    let changed = false;
    for (const [key, l] of this.live) {
      if (l.lastSeen < cutoff) {
        this.live.delete(key);
        changed = true;
      }
    }
    if (changed) this.onChange();
  }

  /** Everything being played now, as this viewer may see it. */
  nowPlaying(viewer: { id: number | null; admin: boolean; kid: boolean }): NowPlaying[] {
    this.sweep();
    const out: NowPlaying[] = [];
    for (const l of this.live.values()) {
      const user = this.users.byId(l.userId);
      if (!user) continue;
      const own = viewer.id === l.userId;
      const g = l.game;
      let title = g.title;
      let coverUrl: string | null = null;
      let href: string | null = null;
      let gameId = g.gameId;
      if (g.source === "lootden" || g.source === "emulated") {
        const game = this.library.get(g.gameId, false);
        if (game) {
          title = game.title;
          coverUrl = game.coverUrl;
          href = `/games/${encodeURIComponent(game.id)}`;
        }
        if (viewer.kid && !own && game?.kidSafe !== true) [title, coverUrl, href, gameId] = ["A grown-up game", null, null, ""];
      } else {
        const m = /^store:([^:]+):(.+)$/.exec(g.gameId);
        if (m) {
          coverUrl = `/api/store-games/${encodeURIComponent(m[1]!)}/${encodeURIComponent(m[2]!)}/cover?title=${encodeURIComponent(g.title)}`;
          href = `/store/${encodeURIComponent(m[1]!)}/${encodeURIComponent(m[2]!)}`;
        }
        // Other launchers' and Roblox games carry no age rating LootDen trusts.
        if (viewer.kid && !own) [title, coverUrl, href, gameId] = [g.source === "roblox" ? "Roblox" : "A game", null, null, ""];
      }
      let remaining: number | null = null;
      if (user.kidMode || viewer.admin || own) {
        const a = this.family.allowance(l.userId);
        remaining = a.remainingSeconds === null ? null : Math.max(0, a.remainingSeconds - this.unreportedSeconds(l.userId));
      }
      out.push({
        userId: l.userId,
        name: user.displayName,
        avatar: user.avatar,
        kid: user.kidMode,
        device: l.device,
        gameId,
        title,
        source: g.source,
        store: g.store ?? null,
        coverUrl,
        href,
        startedAt: g.startedAt,
        remainingSeconds: viewer.admin || own ? remaining : null,
        canControl: viewer.admin,
      });
    }
    return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  /** Play time of games still running: sessions are only recorded when a game closes. */
  private unreportedSeconds(userId: number): number {
    const t = this.clock();
    let total = 0;
    for (const l of this.live.values()) if (l.userId === userId) total += Math.max(0, (t - Date.parse(l.game.startedAt)) / 1000);
    return Math.round(total);
  }

  /** A parent's message or "close the game", for that PC's next heartbeat. */
  send(device: string, from: string, cmd: { kind: "message"; text: unknown } | { kind: "close"; gameId: unknown; text?: unknown } | { kind: "install"; gameId: string; title: string }): PcCommand {
    const known = [...this.live.values()].some((l) => l.device === device) || this.pcRow(device);
    if (!known) throw new Error("No such PC");
    let command: PcCommand;
    if (cmd.kind === "install") command = { id: randomUUID(), kind: "install", gameId: cmd.gameId, title: cmd.title, from };
    else if (cmd.kind === "message") command = { id: randomUUID(), kind: "message", text: cleanPcMessage(cmd.text), from };
    else {
      const gameId = String(cmd.gameId ?? "");
      if (![...this.live.values()].some((l) => l.device === device && l.game.gameId === gameId)) throw new Error("That game isn't running there any more");
      const text = cmd.text === undefined || cmd.text === null || cmd.text === "" ? undefined : cleanPcMessage(cmd.text);
      command = { id: randomUUID(), kind: "close", gameId, from, ...(text ? { text } : {}) };
    }
    const queue = this.commands.get(device) ?? [];
    queue.push({ ...command, at: this.clock() });
    this.commands.set(device, queue.slice(-20));
    return command;
  }

  /** Who signed in to a PC's app last (Send to PC: people may send to their own PCs). */
  lastUserOf(device: string): number | null {
    return this.pcRow(device)?.last_user ?? null;
  }

  /** The PC a game runs on, for parents' buttons on the board. */
  runningOn(userId: number, gameId: string): string | null {
    for (const l of this.live.values()) if (l.userId === userId && l.game.gameId === gameId) return l.device;
    return null;
  }

  // ---- PCs ----------------------------------------------------------------------------

  private pcRow(name: string): PcRow | undefined {
    return this.db.prepare("SELECT * FROM pcs WHERE name = ?").get(name) as PcRow | undefined;
  }

  private savePc(name: string, userId: number, pc: PresenceReport["pc"]): void {
    const before = this.pcRow(name);
    const list = (x: unknown, clean: (s: unknown) => string | null) => (Array.isArray(x) ? [...new Set(x.slice(0, 8).map(clean).filter((s): s is string => !!s))] : null);
    const macs = list(pc?.macs, cleanMac) ?? json<string[]>(before?.macs, []);
    const addresses = list(pc?.addresses, (s) => (/^\d{1,3}(\.\d{1,3}){3}$/.test(String(s)) ? String(s) : null)) ?? json<string[]>(before?.addresses, []);
    const disks: PcDisk[] = Array.isArray(pc?.disks)
      ? pc!.disks.slice(0, 12).flatMap((d) => {
          const free = Number(d?.freeBytes);
          const total = Number(d?.totalBytes);
          return typeof d?.path === "string" && Number.isFinite(free) && Number.isFinite(total) && total > 0 ? [{ path: d.path.slice(0, 200), freeBytes: free, totalBytes: total }] : [];
        })
      : json<PcDisk[]>(before?.disks, []);
    const str = (x: unknown, keep: string | null | undefined) => (typeof x === "string" ? x.slice(0, 40) : (keep ?? null));
    const flag = (x: unknown, keep: number | undefined) => (typeof x === "boolean" ? (x ? 1 : 0) : (keep ?? 0));
    this.db
      .prepare(
        `INSERT INTO pcs (name, macs, addresses, platform, app_version, disks, sunshine, moonlight, last_seen, last_user) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET macs = excluded.macs, addresses = excluded.addresses, platform = excluded.platform, app_version = excluded.app_version,
           disks = excluded.disks, sunshine = excluded.sunshine, moonlight = excluded.moonlight, last_seen = excluded.last_seen, last_user = excluded.last_user`,
      )
      .run(
        name,
        JSON.stringify(macs),
        JSON.stringify(addresses),
        str(pc?.platform, before?.platform),
        str(pc?.appVersion, before?.app_version),
        JSON.stringify(disks),
        flag(pc?.sunshine, before?.sunshine),
        flag(pc?.moonlight, before?.moonlight),
        new Date(this.clock()).toISOString(),
        userId,
      );
  }

  pcs(): PcInfo[] {
    this.sweep();
    const rows = this.db.prepare("SELECT * FROM pcs ORDER BY last_seen DESC").all() as unknown as PcRow[];
    const cutoff = this.clock() - PRESENCE_TIMEOUT_SECONDS * 1000;
    return rows.map((r) => ({
      name: r.name,
      online: Date.parse(r.last_seen) >= cutoff,
      lastSeenAt: r.last_seen,
      lastUser: r.last_user === null ? null : (this.users.byId(r.last_user)?.displayName ?? null),
      macs: json<string[]>(r.macs, []),
      addresses: json<string[]>(r.addresses, []),
      platform: r.platform,
      appVersion: r.app_version,
      disks: json<PcDisk[]>(r.disks, []),
      sunshine: r.sunshine === 1,
      moonlight: r.moonlight === 1,
      playing: [...this.live.values()]
        .filter((l) => l.device === r.name)
        .map((l) => ({ title: l.game.title, name: this.users.byId(l.userId)?.displayName ?? "Someone", startedAt: l.game.startedAt })),
    }));
  }

  /** Admin: forget a PC (an old one, or a renamed one). */
  forgetPc(name: string): boolean {
    return this.db.prepare("DELETE FROM pcs WHERE name = ?").run(name).changes > 0;
  }

  /** Admin: set the MAC address to wake a PC with, when the app didn't report the right card. */
  setMac(name: string, mac: unknown): PcInfo {
    if (!this.pcRow(name)) throw new Error("No such PC");
    const clean = cleanMac(mac);
    if (!clean) throw new Error("That isn't a MAC address (like 1c:69:7a:0b:22:41)");
    const others = json<string[]>(this.pcRow(name)!.macs, []).filter((m) => m !== clean);
    this.db.prepare("UPDATE pcs SET macs = ? WHERE name = ?").run(JSON.stringify([clean, ...others]), name);
    return this.pcs().find((p) => p.name === name)!;
  }

  /** Wake-on-LAN: the magic packet for each of the PC's network cards, broadcast on the home network. */
  async wakePc(name: string): Promise<{ sent: number }> {
    const row = this.pcRow(name);
    if (!row) throw new Error("No such PC");
    const macs = json<string[]>(row.macs, []);
    if (!macs.length) throw new Error("LootDen doesn't know this PC's network card yet. Open the app on it once, or type its MAC address.");
    const targets = broadcastAddresses(json<string[]>(row.addresses, []));
    for (const mac of macs) await this.wake(magicPacket(mac), targets);
    return { sent: macs.length };
  }
}
