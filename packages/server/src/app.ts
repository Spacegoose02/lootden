import { existsSync } from "node:fs";
import path from "node:path";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { API_VERSION, type HealthResponse } from "@lootden/shared";
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
import { extraRoutes } from "./routes/extras.js";
import { Notifier } from "./alerts/notifier.js";
import { Scanner } from "./connectors/scan.js";
import { WantedService } from "./news/wanted.js";
import { VersionChecker } from "./news/version-check.js";
import { JournalStore } from "./users/journal.js";
import { NexusMods } from "./news/nexus.js";
import { HowLongToBeat } from "./metadata/hltb.js";
import { timeToBeat } from "./metadata/time-to-beat.js";
import { SourceRegistry } from "./sources/registry.js";
import { sourceRoutes } from "./routes/sources.js";
import { DirectDownloads } from "./direct/manager.js";
import { directRoutes } from "./routes/direct.js";

export const VERSION = "0.13.0";

/** Routes reachable without signing in. */
const PUBLIC = [/^\/api\/health$/, /^\/api\/auth\//, /^\/api\/avatars\//];

export interface BuildOptions {
  /** Injected for tests so metadata providers never hit the network. */
  fetchImpl?: FetchLike;
  /** Folder with the built web UI; served at / when present. */
  webDir?: string;
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
  const direct = new DirectDownloads(db, library, downloads, log, opts.fetchImpl);
  direct.onEvent = (e) => void notifier.send("failed", `Couldn't download ${e.title}`, e.message ?? null, "/downloads?tab=links");
  downloads.onEvent = (e) => void notifier.send(e.kind, e.kind === "grabbed" ? `Sent ${e.title} to the download client` : `Couldn't download ${e.title}`, e.message ?? null, "/downloads");
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
    wanted: new WantedService(db, wishlist, downloads, notifier),
    versions: new VersionChecker(db, library, updates, notifier, () => settings().itch.apiKey, opts.fetchImpl),
    journal: new JournalStore(db),
    nexus: new NexusMods(() => settings().nexus.apiKey, opts.fetchImpl),
    sources: new SourceRegistry(db, wishlist, notifier, opts.fetchImpl),
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

  app.register(cookie);
  // Raw uploads: images for game artwork (buffered, small) and app files for the
  // client downloads page (streamed to disk, can be hundreds of MB).
  app.addContentTypeParser(/^image\//, { parseAs: "buffer", bodyLimit: 16 * 1024 * 1024 }, (_req, body, done) => done(null, body));
  app.addContentTypeParser("application/octet-stream", (_req, payload, done) => done(null, payload));
  app.decorateRequest("principal", null);

  app.addHook("onRequest", async (req) => {
    const url = req.url.split("?")[0]!;
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
  emulationRoutes(app, ctx);
  newsRoutes(app, ctx);
  downloadRoutes(app, ctx);
  settingsRoutes(app, ctx);
  clientRoutes(app, ctx);
  saveRoutes(app, ctx);
  discoverRoutes(app, ctx);
  wishlistRoutes(app, ctx);
  extraRoutes(app, ctx);
  sourceRoutes(app, ctx);
  directRoutes(app, ctx);

  const webDir = opts.webDir;
  if (webDir && existsSync(path.join(webDir, "index.html"))) {
    app.register(fastifyStatic, { root: webDir });
    // Client-side routing: unknown non-API paths get the app shell.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/") || req.method !== "GET") return reply.code(404).send({ error: "Not found" });
      return reply.sendFile("index.html");
    });
  }

  return { app, ctx };
}
