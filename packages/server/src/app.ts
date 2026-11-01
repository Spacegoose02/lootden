import { existsSync } from "node:fs";
import path from "node:path";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { API_VERSION, platformFor, zonedParts, type HealthResponse } from "@lootden/shared";
import { OidcService } from "./auth/oidc.js";
import { AuthService, SESSION_COOKIE } from "./auth/service.js";
import { Library } from "./catalog/library.js";
import type { ServerConfig } from "./config.js";
import { HttpProblem, type AppContext } from "./context.js";
import type { Db } from "./db/database.js";
import type { FetchLike } from "./metadata/http.js";
import { MetadataService } from "./metadata/service.js";
import { NewsService } from "./news/service.js";
import { DownloadManager } from "./connectors/manager.js";
import { downloadRoutes } from "./routes/downloads.js";
import { newsRoutes } from "./routes/news.js";
import { authRoutes } from "./routes/auth.js";
import { gameRoutes } from "./routes/games.js";
import { userRoutes } from "./routes/users.js";
import { UserRepo } from "./users/repo.js";
import { Integrations } from "./settings/integrations.js";
import { ClientDownloads } from "./clients/store.js";
import { settingsRoutes } from "./routes/settings.js";
import { clientRoutes } from "./routes/clients.js";
import { saveRoutes } from "./routes/saves.js";
import { discoverRoutes } from "./routes/discover.js";
import { wishlistRoutes } from "./routes/wishlist.js";
import { WishlistService } from "./news/wishlist.js";
import { ReleaseCalendar } from "./metadata/calendar.js";
import { VideoService } from "./news/videos.js";
import { SaveStore } from "./saves/store.js";
import { BiosStore } from "./emulation/bios.js";
import { GameUpdates } from "./news/updates.js";
import { FreeGames } from "./news/freegames.js";
import { loadConnectorSettings } from "./connectors/settings.js";
import { emulationRoutes } from "./routes/emulation.js";
import { ISOLATION_HEADERS, loadEmulationSettings, PLAY_PAGE_ISOLATION_HEADERS, PS2_WEB_PREFIX } from "./emulation/ps2-web.js";
import { extraRoutes } from "./routes/extras.js";
import { Notifier } from "./alerts/notifier.js";
import { Scanner } from "./connectors/scan.js";
import { WantedService } from "./news/wanted.js";
import { RequestService } from "./news/requests.js";
import { requestRoutes } from "./routes/requests.js";
import { SteamWorkshop } from "./workshop/steam.js";
import { workshopRoutes } from "./routes/workshop.js";
import { TruckModStore } from "./truckmods/store.js";
import { truckModRoutes } from "./routes/truckmods.js";
import { VersionChecker } from "./news/version-check.js";
import { JournalStore } from "./users/journal.js";
import { NexusMods } from "./news/nexus.js";
import { HowLongToBeat } from "./metadata/hltb.js";
import { timeToBeat } from "./metadata/time-to-beat.js";
import { SourceRegistry } from "./sources/registry.js";
import { sourceRoutes } from "./routes/sources.js";
import { AddonRegistry } from "./addons/registry.js";
import { StoreGameDetails } from "./addons/details.js";
import { SteamSignIn } from "./addons/steam-signin.js";
import { Vault } from "./auth/vault.js";
import type { LibraryAddon } from "./addons/types.js";
import { addonRoutes } from "./routes/addons.js";
import { RobloxCatalog } from "./roblox/catalog.js";
import { robloxRoutes } from "./routes/roblox.js";
import { DirectDownloads } from "./direct/manager.js";
import { directRoutes } from "./routes/direct.js";
import { liveRoutes } from "./routes/live.js";
import { LiveEvents } from "./live.js";
import { familyRoutes } from "./routes/family.js";
import { FamilyService } from "./users/family.js";
import { PresenceService, type WakeSender } from "./users/presence.js";
import { DenDutyLink } from "./users/denduty.js";
import { denDutyRoutes } from "./routes/denduty.js";
import { GameNights } from "./users/gamenight.js";
import { gameNightRoutes } from "./routes/gamenight.js";
import { ScreenshotWall } from "./users/screenshots.js";
import { screenshotRoutes } from "./routes/screenshots.js";
import { AchievementService } from "./users/achievements.js";
import { achievementRoutes } from "./routes/achievements.js";
import { MarkStore } from "./users/marks.js";
import { BackupService } from "./settings/backups.js";
import { CompatService } from "./integrations/compat.js";
import { LudusaviManifest } from "./saves/ludusavi.js";
import { PriceService } from "./integrations/prices.js";
import { HomeAssistantBridge, type HouseState } from "./integrations/homeassistant.js";
import { integrationRoutes } from "./routes/integrations.js";
import { organizeRoutes } from "./routes/organize.js";
import { presenceRoutes } from "./routes/presence.js";
import { LibraryRefresh } from "./catalog/refresh.js";
import { ShelfStore } from "./users/shelves.js";
import { HelperService, type HelperAi } from "./helper/service.js";
import { helperRoutes } from "./routes/helper.js";

export const VERSION = "0.24.2";

/** Routes reachable without signing in. */
// The Steam sign-in callback finds its person by a one-time state value (it may land in a browser nobody is signed in to).
const PUBLIC = [/^\/api\/health$/, /^\/api\/game-nights\/feed\/[^/]+\/game-nights\.ics$/, /^\/api\/auth\//, /^\/api\/avatars\//, /^\/api\/addons\/steam\/signin\/callback$/];

/** The request's path with %-escapes undone; the raw path when it doesn't decode. */
function decodedPath(raw: string): string {
  const p = raw.split("?")[0]!;
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

/** Headers every response gets: no MIME sniffing, no framing by other sites, no full URLs in referrers. */
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "SAMEORIGIN",
  "referrer-policy": "strict-origin-when-cross-origin",
};

/** Play pages for games whose browser emulator needs cross-origin isolation (PS2 through TabStationToo). */
function isolatedPlayPage(ctx: AppContext, id: string): boolean {
  const game = ctx.library.get(id);
  return Boolean(game && platformFor(game.platform).browserPlayer && loadEmulationSettings(ctx.db).ps2Browser);
}

export interface BuildOptions {
  /** Injected for tests so metadata providers never hit the network. */
  fetchImpl?: FetchLike;
  /** Folder with the built web UI; served at / when present. */
  webDir?: string;
  /** Folder with the built TabStationToo site (PS2 in the browser); served at /emulators/ps2/ when present. */
  ps2Dir?: string;
  /** Tests: the library add-ons to offer, and DNS for their private-network check. */
  addons?: LibraryAddon[];
  resolveHost?: (host: string) => Promise<string[]>;
  /** Tests: Bandit's AI, so no request reaches a real provider. */
  helperAi?: HelperAi;
  /** Tests: Wake-on-LAN packets go here instead of the network. */
  wake?: WakeSender;
}

type Log = { info(o: object, m: string): void; warn(o: object, m: string): void };

export function buildContext(config: ServerConfig, db: Db, log: Log, opts: BuildOptions = {}): AppContext {
  const library = new Library(db, config.gamesDir);
  const users = new UserRepo(db);
  // Applies keys and sign-on settings saved in the UI on top of the environment.
  const integrations = new Integrations(db, config);
  const metadata = new MetadataService(db, library, config.dataDir, config, log, opts.fetchImpl);
  const settings = () => loadConnectorSettings(db);
  const updates = new GameUpdates(opts.fetchImpl);
  const wishlist = new WishlistService(db, library, opts.fetchImpl);
  const downloads = new DownloadManager(db, library, log, opts.fetchImpl);
  const notifier = new Notifier(db, () => settings().notify, () => config.publicUrl ?? "", opts.fetchImpl, log);
  const scanner = new Scanner(db, config.gamesDir, () => settings().scan, opts.fetchImpl);
  // Imports are scanned before they join the library; flagged ones wait in .held/ for a decision.
  downloads.afterImport = async (target, name) => {
    const r = await scanner.check(target, name);
    if (r.error) log.warn({ name, error: r.error }, "Virus scan failed; imported anyway");
    if (r.findings.length) await notifier.send("flagged", `${name} was flagged`, r.findings.map((f) => `${f.threat} in ${f.file}`).join("\n"), "/downloads");
    else if (r.path) await notifier.send("imported", `${name} is in the library`, null, "/library");
    return r.path;
  };
  const wanted = new WantedService(db, wishlist, downloads, notifier);
  const direct = new DirectDownloads(db, library, downloads, log, opts.fetchImpl);
  const live = new LiveEvents();
  library.onScanned(() => live.publish("library"));
  metadata.onLookedUp = () => live.publish("library");
  notifier.onSent = () => live.publish("alerts", true);
  direct.onChange = () => live.publish("downloads", true);
  direct.onEvent = (e) => void notifier.send("failed", `Couldn't download ${e.title}`, e.message ?? null, "/downloads?tab=links");
  downloads.onEvent = (e) => {
    live.publish("downloads", true);
    void notifier.send(e.kind, e.kind === "grabbed" ? `Sent ${e.title} to the download client` : `Couldn't download ${e.title}`, e.message ?? null, "/downloads");
  };
  const requests = new RequestService(db, library, wishlist, wanted, downloads, notifier);
  const vault = Vault.open(config.dataDir, config.secretKey);
  const roblox = new RobloxCatalog(db, opts.fetchImpl);
  const addons = new AddonRegistry(db, library, opts.fetchImpl, opts.addons, opts.resolveHost, vault);
  addons.extraGames = (userId) => roblox.storeGames(userId);
  const family = new FamilyService(db, library, users, () => requests, notifier);
  const presence = new PresenceService(db, users, library, family, opts.wake);
  const houseState = (): HouseState => {
    const playing = presence.nowPlaying({ id: null, admin: true, kid: false });
    return {
      people: users.list().map((u) => {
        const p = playing.find((x) => x.userId === u.id);
        return {
          id: u.id,
          name: u.displayName,
          playing: p ? { title: p.title, device: p.device, startedAt: p.startedAt, remainingMinutes: p.remainingSeconds == null ? null : Math.round(p.remainingSeconds / 60), picture: p.coverUrl } : null,
        };
      }),
      games: (db.prepare("SELECT COUNT(*) AS n FROM games").get() as { n: number }).n,
      pcsOnline: presence.pcs().filter((pc) => pc.online).length,
      downloads: (db.prepare("SELECT COUNT(*) AS n FROM downloads WHERE status = 'downloading'").get() as { n: number }).n,
    };
  };
  const homeAssistant = new HomeAssistantBridge(db, houseState, () => config.publicUrl ?? "", log);
  presence.onChange = () => {
    live.publish("playing");
    homeAssistant.changed();
  };
  const libraryRefresh = new LibraryRefresh(library, presence);
  libraryRefresh.onChange = () => live.publish("library");
  const denDuty = new DenDutyLink(db, vault, users, family, presence, opts.fetchImpl);
  family.externalLock = (userId) => denDuty.lockFor(userId);
  const gameNights = new GameNights(db, library, users, family, denDuty);
  return {
    config,
    db,
    library,
    users,
    integrations,
    clients: new ClientDownloads(config.dataDir, opts.fetchImpl, db),
    saves: new SaveStore(db, config.dataDir),
    bios: new BiosStore(db, config.dataDir),
    updates,
    freeGames: new FreeGames(opts.fetchImpl, () => settings().itch.apiKey),
    auth: new AuthService(db, users, config),
    oidc: new OidcService(config, users),
    metadata,
    calendar: new ReleaseCalendar(metadata, library, opts.fetchImpl),
    wishlist,
    videos: new VideoService(db, opts.fetchImpl),
    news: new NewsService(db, opts.fetchImpl),
    downloads,
    direct,
    notifier,
    scanner,
    wanted,
    requests,
    workshop: new SteamWorkshop(opts.fetchImpl),
    truckMods: new TruckModStore(db, config.dataDir),
    versions: new VersionChecker(db, library, updates, notifier, () => settings().itch.apiKey, opts.fetchImpl),
    journal: new JournalStore(db),
    nexus: new NexusMods(() => settings().nexus.apiKey, opts.fetchImpl),
    sources: new SourceRegistry(db, wishlist, notifier, opts.fetchImpl),
    addons,
    roblox,
    storeDetails: new StoreGameDetails(db, metadata, config.dataDir, log),
    steamSignIn: new SteamSignIn(opts.fetchImpl),
    live,
    family,
    presence,
    libraryRefresh,
    denDuty,
    gameNights,
    screenshots: new ScreenshotWall(db, config.dataDir, users, library),
    achievements: new AchievementService(db, addons, opts.fetchImpl),
    marks: new MarkStore(db),
    backups: new BackupService(db, config.dataDir),
    compat: new CompatService(db, opts.fetchImpl),
    ludusavi: new LudusaviManifest(config.dataDir, opts.fetchImpl),
    prices: new PriceService(db, wishlist, notifier, opts.fetchImpl),
    homeAssistant,
    helper: new HelperService(db, vault, config.anthropicApiKey, () => zonedParts(new Date(), family.timeZone()).date, opts.helperAi),
    shelves: new ShelfStore(db, library),
    timeToBeat: timeToBeat(metadata.igdb, new HowLongToBeat(opts.fetchImpl), () => settings().hltb.enabled !== false),
  };
}

export function buildApp(config: ServerConfig, db: Db, opts: BuildOptions = {}): { app: FastifyInstance; ctx: AppContext } {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      serializers: {
        // Keep ?token= out of the logs.
        req: (req) => ({ method: req.method, url: req.url.replace(/([?&]token=)[^&]*/, "$1***"), remoteAddress: req.ip }),
      },
    },
    trustProxy: config.headerAuth.trustedProxies.length ? config.headerAuth.trustedProxies : false,
  });
  const ctx = buildContext(config, db, app.log, opts);
  // Smart shelves see the person looking's statuses, tags and play.
  ctx.shelves.ruleContext = (userId) => {
    const statuses = new Map(ctx.journal.statuses(userId).map((s) => [s.gameId, s.status as string]));
    const marks = ctx.marks.all(userId);
    const states = ctx.users.gameStates(userId);
    const played = new Set(states.filter((s) => s.playtimeSeconds > 0 || s.lastPlayedAt).map((s) => s.gameId));
    const installed = new Set(states.filter((s) => s.installedAt && !s.uninstalledAt).map((s) => s.gameId));
    return {
      status: (id) => statuses.get(id) ?? null,
      marks: (id) => marks.get(id) ?? { favourite: false, hidden: false, tags: [], fields: {} },
      played: (id) => played.has(id),
      installed: (id) => installed.has(id),
    };
  };

  app.register(cookie);
  // Raw uploads: images for game artwork (buffered, small) and app files for the
  // client downloads page (streamed to disk, can be hundreds of MB).
  app.addContentTypeParser(/^image\//, { parseAs: "buffer", bodyLimit: 16 * 1024 * 1024 }, (_req, body, done) => done(null, body));
  app.addContentTypeParser("application/octet-stream", (_req, payload, done) => done(null, payload));
  app.decorateRequest("principal", null);
  app.addHook("onSend", async (_req, reply) => {
    reply.headers(SECURITY_HEADERS);
  });

  app.addHook("onRequest", async (req) => {
    // The matched route, not the raw URL: the router decodes "/%61pi/games" to /api/games,
    // so checking req.url alone let encoded paths skip sign-in.
    const url = req.routeOptions.url ?? decodedPath(req.url);
    const header = req.headers.authorization;
    const bearer = header?.startsWith("Bearer ") ? header.slice(7) : (req.query as Record<string, string | undefined>)?.token;
    if (bearer) {
      req.principal = ctx.auth.fromBearer(bearer);
      if (!req.principal) throw new HttpProblem(401, "Invalid token");
    } else {
      const session = req.cookies?.[SESSION_COOKIE];
      req.principal = (session && ctx.auth.fromSession(session)) || (await ctx.auth.fromHeaders(req.socket.remoteAddress ?? "", req.headers));
    }
    if (!req.principal && url.startsWith("/api/") && !PUBLIC.some((r) => r.test(url))) {
      throw new HttpProblem(401, "Sign in first");
    }
  });

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, req, reply) => {
    const status = err instanceof HttpProblem ? err.statusCode : err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    if (status >= 500) req.log.error(err);
    const message = status >= 500 && !(err instanceof HttpProblem) ? "Internal error" : err.message;
    // Plain Errors thrown from repositories carry user-facing validation messages.
    const isUserError = !(err instanceof HttpProblem) && !err.statusCode && /^(Usernames|User "|Passwords|Unknown|Metadata provider|.* has no game)/.test(err.message);
    reply.code(isUserError ? 400 : status).send({ error: isUserError ? err.message : message });
  });

  app.get("/api/health", async (): Promise<HealthResponse> => ({ status: "ok", version: VERSION, apiVersion: API_VERSION }));

  authRoutes(app, ctx);
  userRoutes(app, ctx);
  gameRoutes(app, ctx);
  emulationRoutes(app, ctx, opts.ps2Dir ?? "");
  newsRoutes(app, ctx);
  downloadRoutes(app, ctx);
  settingsRoutes(app, ctx);
  clientRoutes(app, ctx);
  saveRoutes(app, ctx);
  discoverRoutes(app, ctx);
  wishlistRoutes(app, ctx);
  requestRoutes(app, ctx);
  workshopRoutes(app, ctx);
  truckModRoutes(app, ctx);
  extraRoutes(app, ctx);
  sourceRoutes(app, ctx);
  addonRoutes(app, ctx);
  achievementRoutes(app, ctx);
  organizeRoutes(app, ctx);
  integrationRoutes(app, ctx);
  robloxRoutes(app, ctx);
  directRoutes(app, ctx);
  liveRoutes(app, ctx);
  // Open event streams would hold shutdown up.
  app.addHook("preClose", async () => ctx.live.close());
  familyRoutes(app, ctx);
  presenceRoutes(app, ctx);
  denDutyRoutes(app, ctx);
  gameNightRoutes(app, ctx);
  screenshotRoutes(app, ctx);
  helperRoutes(app, ctx);

  // TabStationToo for PS2 games in the browser, cross-origin isolated, unless an admin switched it off.
  const ps2Dir = opts.ps2Dir;
  if (ps2Dir && existsSync(path.join(ps2Dir, "index.html"))) {
    app.register(async (scope) => {
      scope.addHook("onRequest", async (_req, reply) => {
        if (!loadEmulationSettings(ctx.db).ps2Browser) return reply.code(404).send({ error: "PS2 in the browser is turned off" });
      });
      await scope.register(fastifyStatic, {
        root: ps2Dir,
        prefix: PS2_WEB_PREFIX,
        decorateReply: false,
        // Its page stamps every file with ?v=<build>, so only the page itself must be checked each time.
        setHeaders: (res, file) => {
          for (const [k, v] of Object.entries(ISOLATION_HEADERS)) res.header(k, v);
          res.header("cache-control", file.endsWith(".html") ? "no-cache" : "public, max-age=3600");
        },
      });
    });
  }

  const webDir = opts.webDir;
  if (webDir && existsSync(path.join(webDir, "index.html"))) {
    app.register(fastifyStatic, { root: webDir });
    // Client-side routing: unknown non-API paths get the app shell.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/") || req.method !== "GET") return reply.code(404).send({ error: "Not found" });
      // A PS2 game's play page holds the emulator's frame, which is only isolated when this page is.
      const play = /^\/play\/([^/?#]+)/.exec(req.url);
      if (play && isolatedPlayPage(ctx, decodedPath(play[1]!))) reply.headers(PLAY_PAGE_ISOLATION_HEADERS);
      return reply.sendFile("index.html");
    });
  }

  return { app, ctx };
}
