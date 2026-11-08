import { createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rm, stat, statfs } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { safeFolderName, type GameDetail, type PeerSource } from "@lootden/shared";
import type { GameServerClient } from "./api.js";
import { downloadFile } from "./downloader.js";
import { finishInstall, type InstallEvent } from "./installer.js";
import type { RateLimiter } from "./throttle.js";
import { listGameFiles } from "./verify.js";

export const PEER_PORT = 47631;
const PREFIX = "/lootden-peer/v1/games/";

/** Checks a ticket the server signed for this PC: the right game, not expired, untouched. */
export function checkTicket(ticket: string, key: string, gameId: string, now = Date.now()): boolean {
  const [payload, sig] = String(ticket).split(".");
  if (!payload || !sig || !key) return false;
  const want = createHmac("sha256", Buffer.from(key, "base64url")).update(payload).digest();
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return false;
  try {
    const t = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { g?: string; exp?: number };
    return t.g === gameId && typeof t.exp === "number" && t.exp * 1000 > now;
  } catch {
    return false;
  }
}

export interface PeerShareOptions {
  /** The key the server gave this PC (it changes only if the server forgets the PC). */
  key: () => string | null;
  /** Where a LootDen game is installed on this PC, or null. */
  gameDir: (gameId: string) => Promise<string | null>;
  port?: number;
  /** Uploads to other PCs share this PC's speed limit. */
  limiter?: RateLimiter;
  log?: (msg: string) => void;
}

/**
 * Shares this PC's installed LootDen games with the other PCs in the house: they copy a game
 * from here instead of downloading it from the server. Only with a ticket the server signed for
 * that game, and only the game's own files (the list made when it was installed).
 */
export class PeerShare {
  private server: Server | null = null;
  private active = 0;

  constructor(private readonly opts: PeerShareOptions) {}

  get port(): number | null {
    const a = this.server?.address();
    return a && typeof a === "object" ? a.port : null;
  }

  async start(): Promise<number> {
    if (this.server) return this.port!;
    const server = createServer((req, res) => void this.handle(req, res).catch(() => this.fail(res, 500, "Couldn't share that file")));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.opts.port ?? PEER_PORT, "0.0.0.0", () => resolve());
    });
    this.server = server;
    return this.port!;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }

  private fail(res: ServerResponse, status: number, message: string): void {
    if (res.headersSent) return void res.destroy();
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: message }));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://peer");
    if (req.method !== "GET" || !url.pathname.startsWith(PREFIX)) return this.fail(res, 404, "Not found");
    const [rawId, what] = url.pathname.slice(PREFIX.length).split("/");
    const gameId = decodeURIComponent(rawId ?? "");
    const key = this.opts.key();
    if (!key || !checkTicket(url.searchParams.get("t") ?? "", key, gameId)) return this.fail(res, 403, "That ticket isn't for this game, or it's expired");
    const dir = await this.opts.gameDir(gameId);
    if (!dir) return this.fail(res, 404, "That game isn't installed here any more");
    // Only files that are still there: a damaged install shares what it has, and the copying PC checks sizes.
    const files = (await listGameFiles(dir)).filter((f) => f.size >= 0);
    if (what === "files") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ files: files.map((f) => ({ path: f.path, size: f.size })) }));
      return;
    }
    if (what !== "file") return this.fail(res, 404, "Not found");
    const rel = url.searchParams.get("p") ?? "";
    const entry = files.find((f) => f.path === rel);
    if (!entry) return this.fail(res, 404, "Not one of the game's files");
    const full = path.resolve(dir, ...rel.split("/"));
    if (!full.startsWith(path.resolve(dir) + path.sep)) return this.fail(res, 403, "Refusing that path");
    const size = (await stat(full)).size;
    let start = 0;
    const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
    if (range) start = Number(range[1]);
    if (start > size) {
      res.writeHead(416, { "content-range": `bytes */${size}` }).end();
      return;
    }
    res.writeHead(range ? 206 : 200, {
      "content-type": "application/octet-stream",
      "content-length": String(size - start),
      ...(range ? { "content-range": `bytes ${start}-${size - 1}/${size}` } : {}),
    });
    if (size === start) return void res.end();
    this.active++;
    const stream = createReadStream(full, { start });
    const body = this.opts.limiter ? stream.pipe(this.opts.limiter.stream()) : stream;
    body.pipe(res);
    const done = () => {
      this.active = Math.max(0, this.active - 1);
      stream.destroy();
    };
    res.once("close", done);
  }

  /** Copies going to other PCs right now. */
  busy(): number {
    return this.active;
  }
}

/** The IPv4 addresses other PCs at home can reach this one on. */
export function lanAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((n): n is os.NetworkInterfaceInfo => !!n && n.family === "IPv4" && !n.internal)
    .map((n) => n.address)
    .filter((a) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.)/.test(a));
}

export interface PeerInstallOptions {
  installDir: string;
  device?: string;
  signal?: AbortSignal;
  limiter?: RateLimiter;
  onEvent?: (event: InstallEvent | { type: "peer"; device: string }) => void;
}

/**
 * Copies a game from another PC in the house (already unpacked, so nothing to extract), then
 * finishes the install like a download from the server would. Throws when the PC can't be
 * reached, so the caller can fall back to the server.
 */
export async function installFromPeer(api: GameServerClient, gameId: string, source: PeerSource, opts: PeerInstallOptions): Promise<string> {
  const game = await api.getGame(gameId);
  let base: string | null = null;
  let files: Array<{ path: string; size: number }> = [];
  const q = (extra = "") => `t=${encodeURIComponent(source.ticket)}${extra}`;
  for (const u of source.urls) {
    try {
      const res = await fetch(`${u}${PREFIX}${encodeURIComponent(gameId)}/files?${q()}`, { signal: AbortSignal.any([AbortSignal.timeout(5_000), ...(opts.signal ? [opts.signal] : [])]) });
      if (!res.ok) continue;
      files = ((await res.json()) as { files: Array<{ path: string; size: number }> }).files;
      base = u;
      break;
    } catch {
      opts.signal?.throwIfAborted();
    }
  }
  if (!base || !files.length) throw new Error(`Couldn't reach ${source.device} on the network`);
  const total = files.reduce((n, f) => n + f.size, 0);
  const gameDir = path.join(opts.installDir, safeFolderName(game.title));
  const existed = await stat(gameDir).then(() => true, () => false);
  await mkdir(gameDir, { recursive: true });
  try {
    return await copyAll(api, game, gameDir, base, files, total, source, opts, q);
  } catch (err) {
    // A half copy would get in the way of downloading from the server instead.
    // Not when paused or stopped by the download window: it resumes from here.
    if (!existed && !opts.signal?.aborted) await rm(gameDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

async function copyAll(
  api: GameServerClient,
  game: GameDetail,
  gameDir: string,
  base: string,
  files: Array<{ path: string; size: number }>,
  total: number,
  source: PeerSource,
  opts: PeerInstallOptions,
  q: (extra?: string) => string,
): Promise<string> {
  const emit = opts.onEvent ?? (() => {});
  const gameId = game.id;
  try {
    const s = await statfs(gameDir);
    if (s.bavail * s.bsize < total) throw new Error(`Not enough space in ${opts.installDir}: need ${total} bytes`);
  } catch (err) {
    if ((err as Error).message.startsWith("Not enough space")) throw err;
  }
  emit({ type: "peer", device: source.device });
  emit({ type: "start", game, gameDir });
  let i = 0;
  for (const f of files) {
    const dest = path.resolve(gameDir, ...f.path.split("/"));
    if (!dest.startsWith(path.resolve(gameDir) + path.sep)) throw new Error(`Refusing unsafe path from ${source.device}: ${f.path}`);
    const index = i++;
    await downloadFile({
      url: `${base}${PREFIX}${encodeURIComponent(gameId)}/file?${q(`&p=${encodeURIComponent(f.path)}`)}`,
      headers: {},
      dest,
      expectedSize: f.size,
      signal: opts.signal,
      limiter: opts.limiter,
      onProgress: (received, size) => emit({ type: "download", file: f.path, index, count: files.length, received, total: size }),
    });
  }
  await finishInstall(api, game, gameDir, { device: opts.device, onEvent: opts.onEvent as (e: InstallEvent) => void });
  emit({ type: "done", gameDir });
  return gameDir;
}
