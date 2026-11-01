import type { ActivityEvent, Allowance, PresenceAnswer, PresenceReport, GameDetail, PlayLimits, GameSummary, HealthResponse, LibraryStats, SaveBackup, TruckGame, TruckMod, User } from "@lootden/shared";
import type { ClientConfig } from "./config.js";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** Small enough for a default Cloudflare tunnel (100 MB) and most reverse proxy setups. */
export const UPLOAD_PART_BYTES = 16 * 1024 * 1024;

const causeOf = (err: Error) => String((err.cause as Error | undefined)?.message ?? err.message);

/** The server's own message, or a short line instead of a proxy's HTML error page. */
async function uploadError(res: Response): Promise<ApiError> {
  const text = await res.text().catch(() => "");
  let detail = "";
  try {
    detail = (JSON.parse(text) as { error?: string }).error ?? "";
  } catch {
    detail = text.replace(/<(script|style)[^]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
  }
  const hint =
    res.status === 413
      ? "Something between this PC and the server (a reverse proxy such as Nginx Proxy Manager, Traefik or a Cloudflare tunnel) refused a 16 MB upload. Raise its upload limit (client_max_body_size in Nginx) or point the app straight at the server's own address."
      : res.status === 401 || res.status === 403
        ? "Sign in on this PC with an admin profile."
        : "";
  return new ApiError(`Uploading the installed game failed with ${res.status}${detail ? `: ${detail}` : ""}${hint ? `. ${hint}` : ""}`, res.status);
}

export class GameServerClient {
  private readonly base: string;

  constructor(private readonly config: Pick<ClientConfig, "serverUrl" | "apiToken">) {
    this.base = config.serverUrl.replace(/\/+$/, "");
  }

  headers(extra: Record<string, string> = {}): Record<string, string> {
    return this.config.apiToken ? { Authorization: `Bearer ${this.config.apiToken}`, ...extra } : extra;
  }

  async json<T>(pathname: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(this.base + pathname, { ...init, headers: this.headers((init.headers ?? {}) as Record<string, string>) });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ApiError(`${init.method ?? "GET"} ${pathname} failed with ${res.status}: ${body}`, res.status);
    }
    return (await res.json()) as T;
  }

  health() {
    return this.json<HealthResponse>("/api/health");
  }
  listGames(search?: string) {
    return this.json<GameSummary[]>(`/api/games${search ? `?search=${encodeURIComponent(search)}` : ""}`);
  }
  getGame(id: string) {
    return this.json<GameDetail>(`/api/games/${encodeURIComponent(id)}`);
  }
  stats() {
    return this.json<LibraryStats>("/api/library/stats");
  }
  rescan() {
    return this.json<LibraryStats>("/api/library/rescan", { method: "POST" });
  }
  /** Exchanges a username and password for a personal API token for this device. */
  async login(username: string, password: string, device: string): Promise<{ token: string; user: User }> {
    const res = await fetch(`${this.base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, client: true, device }),
    });
    const body = (await res.json().catch(() => ({}))) as { token: string; user: User; error?: string };
    if (!res.ok) throw new ApiError(body.error ?? `Login failed with ${res.status}`, res.status);
    return body;
  }
  me() {
    return this.json<{ user: User | null; role: string; via: string }>("/api/me");
  }
  /**
   * Install/uninstall/playtime reports; ignored for the service token, which has no profile.
   * Never throws: false means the server couldn't be reached, so the caller can keep it for later.
   */
  async reportActivity(a: { gameId: string; device: string; event: ActivityEvent; installPath?: string; seconds?: number; endedAt?: string }): Promise<boolean> {
    const res = await fetch(`${this.base}/api/me/activity`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(a),
    }).catch(() => undefined);
    return !!res;
  }
  /** The heartbeat: what runs on this PC. The answer carries parents' messages for it (404 on older servers). */
  presence(report: PresenceReport) {
    return this.json<PresenceAnswer>("/api/me/presence", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(report) });
  }
  /** Today's play time and limits for the person this token belongs to (404 on servers from before limits). */
  allowance() {
    return this.json<Allowance & { limits: PlayLimits; separateSaves: boolean; userId: number }>("/api/me/allowance");
  }
  listSaves(gameId: string) {
    return this.json<SaveBackup[]>(`/api/games/${encodeURIComponent(gameId)}/saves`);
  }
  async uploadSave(gameId: string, zip: Uint8Array, device: string): Promise<SaveBackup> {
    const pathname = `/api/games/${encodeURIComponent(gameId)}/saves?device=${encodeURIComponent(device)}`;
    const res = await fetch(this.base + pathname, { method: "POST", headers: this.headers({ "Content-Type": "application/octet-stream" }), body: new Blob([zip as Uint8Array<ArrayBuffer>]) });
    if (!res.ok) throw new ApiError(`Uploading saves failed with ${res.status}: ${await res.text().catch(() => "")}`, res.status);
    return (await res.json()) as SaveBackup;
  }
  async downloadSave(gameId: string, saveId: number): Promise<Uint8Array> {
    const res = await fetch(`${this.base}/api/games/${encodeURIComponent(gameId)}/saves/${saveId}`, { headers: this.headers() });
    if (!res.ok) throw new ApiError(`Downloading saves failed with ${res.status}`, res.status);
    return new Uint8Array(await res.arrayBuffer());
  }
  /**
   * Admin: replaces a disc or installer game with a zip of the installed game. It goes up in
   * parts, so a reverse proxy's upload size limit doesn't stop a many-GB game, and a part that
   * fails is sent again instead of starting over.
   */
  async uploadPrepared(gameId: string, zipPath: string, version?: string, onProgress?: (sent: number, total: number) => void): Promise<GameDetail> {
    const { open, stat } = await import("node:fs/promises");
    const { randomUUID } = await import("node:crypto");
    const total = (await stat(zipPath)).size;
    const game = `/api/games/${encodeURIComponent(gameId)}/prepared`;
    const upload = `${game}/parts/${randomUUID()}`;
    const qs = version ? `?version=${encodeURIComponent(version)}` : "";
    const file = await open(zipPath, "r");
    try {
      let sent = 0;
      let failures = 0;
      while (sent < total || sent === 0) {
        const chunk = Buffer.alloc(Math.min(UPLOAD_PART_BYTES, total - sent));
        await file.read(chunk, 0, chunk.length, sent);
        const res = await fetch(`${this.base}${upload}?offset=${sent}`, {
          method: "PUT",
          headers: this.headers({ "Content-Type": "application/octet-stream" }),
          body: chunk,
        }).catch((err: Error) => err);
        if (res instanceof Response && res.status === 404 && sent === 0 && /"error":"Not found"|Route PUT/.test(await res.clone().text())) {
          return await this.uploadPreparedWhole(gameId, zipPath, qs); // a server from before 0.13
        }
        if (res instanceof Response && res.ok) {
          sent = ((await res.json()) as { size: number }).size;
          failures = 0;
          onProgress?.(sent, total);
          if (total === 0) break;
          continue;
        }
        // 4xx other than a timeout or a lost place won't get better by trying again.
        if (res instanceof Response && res.status < 500 && ![408, 409, 429].includes(res.status)) throw await uploadError(res);
        if (++failures > 4) throw res instanceof Response ? await uploadError(res) : new Error(`Uploading the installed game failed: the server stopped answering (${causeOf(res)})`);
        await new Promise((r) => setTimeout(r, 2000 * 2 ** (failures - 1)));
        // Pick up where the server says it is.
        const where = await fetch(this.base + upload, { headers: this.headers() }).catch(() => null);
        if (where?.ok) sent = ((await where.json()) as { size: number }).size;
      }
    } finally {
      await file.close();
    }
    const res = await fetch(`${this.base}${upload}/finish${qs}`, { method: "POST", headers: this.headers() });
    if (!res.ok) throw await uploadError(res);
    return (await res.json()) as GameDetail;
  }
  private async uploadPreparedWhole(gameId: string, zipPath: string, qs: string): Promise<GameDetail> {
    const { createReadStream } = await import("node:fs");
    const { stat } = await import("node:fs/promises");
    const { Readable } = await import("node:stream");
    const size = (await stat(zipPath)).size;
    const res = await fetch(`${this.base}/api/games/${encodeURIComponent(gameId)}/prepared${qs}`, {
      method: "PUT",
      headers: this.headers({ "Content-Type": "application/octet-stream", "Content-Length": String(size) }),
      body: Readable.toWeb(createReadStream(zipPath)) as ReadableStream,
      duplex: "half",
    } as RequestInit);
    if (!res.ok) throw await uploadError(res);
    return (await res.json()) as GameDetail;
  }
  /** Raw bytes of a server file (BIOS files for the emulators). */
  async download(pathname: string): Promise<Uint8Array> {
    const res = await fetch(this.base + pathname, { headers: this.headers() });
    if (!res.ok) throw new ApiError(`GET ${pathname} failed with ${res.status}`, res.status);
    return new Uint8Array(await res.arrayBuffer());
  }
  /** The mods kept on the server for a truck game (ATS, ETS2). */
  listTruckMods(game: TruckGame) {
    return this.json<TruckMod[]>(`/api/truck-mods?game=${game}`);
  }
  /** Keeps a mod on the server so other PCs can add it; the same file name for the game replaces the old one. */
  async uploadTruckMod(game: TruckGame, filePath: string, info: { fileName: string; title?: string | null; sourceUrl?: string | null; modVersion?: string | null; compatibleVersions?: string[] }): Promise<TruckMod> {
    const { createReadStream } = await import("node:fs");
    const { stat } = await import("node:fs/promises");
    const { Readable } = await import("node:stream");
    const size = (await stat(filePath)).size;
    const qs = new URLSearchParams({ game, name: info.fileName });
    if (info.title) qs.set("title", info.title);
    if (info.sourceUrl) qs.set("source", info.sourceUrl);
    if (info.modVersion) qs.set("version", info.modVersion);
    if (info.compatibleVersions?.length) qs.set("compat", info.compatibleVersions.join(","));
    const res = await fetch(`${this.base}/api/truck-mods?${qs}`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/octet-stream", "Content-Length": String(size) }),
      body: Readable.toWeb(createReadStream(filePath)) as ReadableStream,
      duplex: "half",
    } as RequestInit);
    if (!res.ok) {
      const detail = await res.json().then((b: { error?: string }) => b.error ?? "", () => "");
      throw new ApiError(res.status === 404 ? "This server doesn't keep truck mods yet; update it to share mods between PCs" : `Couldn't keep the mod on the server (${res.status})${detail ? `: ${detail}` : ""}`, res.status);
    }
    return (await res.json()) as TruckMod;
  }
  /** Streams a truck mod's file from the server to dest. */
  async downloadTruckMod(id: number, dest: string, onProgress?: (got: number, total: number) => void): Promise<void> {
    const { createWriteStream } = await import("node:fs");
    const { Readable, Transform } = await import("node:stream");
    const { pipeline } = await import("node:stream/promises");
    const res = await fetch(`${this.base}/api/truck-mods/${id}/file`, { headers: this.headers() });
    if (!res.ok || !res.body) throw new ApiError(`Couldn't get the mod from the server (${res.status})`, res.status);
    const total = Number(res.headers.get("content-length") ?? 0);
    let got = 0;
    const count = new Transform({
      transform(chunk: Buffer, _enc, done) {
        got += chunk.length;
        onProgress?.(got, total);
        done(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body as never), count, createWriteStream(dest));
  }
  fileUrl(gameId: string, index: number): string {
    return `${this.base}/api/games/${encodeURIComponent(gameId)}/files/${index}`;
  }
}
