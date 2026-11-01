import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuthService, Principal } from "./auth/service.js";
import type { OidcService } from "./auth/oidc.js";
import type { Library } from "./catalog/library.js";
import type { ServerConfig } from "./config.js";
import type { DownloadManager } from "./connectors/manager.js";
import type { Db } from "./db/database.js";
import type { MetadataService } from "./metadata/service.js";
import type { NewsService } from "./news/service.js";
import type { UserRepo } from "./users/repo.js";
import type { Integrations } from "./settings/integrations.js";
import type { ClientDownloads } from "./clients/store.js";
import type { SaveStore } from "./saves/store.js";
import type { BiosStore } from "./emulation/bios.js";
import type { GameUpdates } from "./news/updates.js";
import type { FreeGames } from "./news/freegames.js";
import type { WishlistService } from "./news/wishlist.js";
import type { ReleaseCalendar } from "./metadata/calendar.js";
import type { VideoService } from "./news/videos.js";
import type { Notifier } from "./alerts/notifier.js";
import type { Scanner } from "./connectors/scan.js";
import type { WantedService } from "./news/wanted.js";
import type { RequestService } from "./news/requests.js";
import type { SteamWorkshop } from "./workshop/steam.js";
import type { TruckModStore } from "./truckmods/store.js";
import type { VersionChecker } from "./news/version-check.js";
import type { JournalStore } from "./users/journal.js";
import type { NexusMods } from "./news/nexus.js";
import type { TimeToBeat } from "./metadata/time-to-beat.js";
import type { SourceRegistry } from "./sources/registry.js";
import type { DirectDownloads } from "./direct/manager.js";
import type { AddonRegistry } from "./addons/registry.js";
import type { StoreGameDetails } from "./addons/details.js";
import type { SteamSignIn } from "./addons/steam-signin.js";
import type { LiveEvents } from "./live.js";
import type { FamilyService } from "./users/family.js";
import type { ShelfStore } from "./users/shelves.js";
import type { HelperService } from "./helper/service.js";
import type { RobloxCatalog } from "./roblox/catalog.js";
import type { PresenceService } from "./users/presence.js";

/** Everything route modules need, built once in buildApp. */
export interface AppContext {
  config: ServerConfig;
  db: Db;
  library: Library;
  users: UserRepo;
  auth: AuthService;
  oidc: OidcService;
  metadata: MetadataService;
  news: NewsService;
  downloads: DownloadManager;
  /** Download Manager: games fetched from file-host links. */
  direct: DirectDownloads;
  integrations: Integrations;
  clients: ClientDownloads;
  saves: SaveStore;
  bios: BiosStore;
  updates: GameUpdates;
  freeGames: FreeGames;
  wishlist: WishlistService;
  calendar: ReleaseCalendar;
  videos: VideoService;
  notifier: Notifier;
  scanner: Scanner;
  wanted: WantedService;
  requests: RequestService;
  workshop: SteamWorkshop;
  /** ATS and ETS2 mods shared between PCs. */
  truckMods: TruckModStore;
  versions: VersionChecker;
  journal: JournalStore;
  nexus: NexusMods;
  sources: SourceRegistry;
  /** Library add-ons: people's Steam, GOG, Epic... accounts and the games they own there. */
  addons: AddonRegistry;
  storeDetails: StoreGameDetails;
  /** Roblox experiences an admin picked, shown to the profiles they chose. */
  roblox: RobloxCatalog;
  steamSignIn: SteamSignIn;
  /** Tells open pages what changed (GET /api/events). */
  live: LiveEvents;
  /** Play time limits, bonus time, achievements, the weekly recap and celebrations. */
  family: FamilyService;
  shelves: ShelfStore;
  /** Now Playing, parents' messages to PCs and the household's PCs (Wake-on-LAN). */
  presence: PresenceService;
  /** Bandit, the AI gaming helper. */
  helper: HelperService;
  timeToBeat: (providerId: string | null, title: string) => Promise<TimeToBeat | null>;
}

declare module "fastify" {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

export class HttpProblem extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export function requireUser(req: FastifyRequest): Principal {
  if (!req.principal) throw new HttpProblem(401, "Sign in first");
  return req.principal;
}

/** A signed-in person (not the service token), for routes about "my" account. */
export function requirePerson(req: FastifyRequest) {
  const p = requireUser(req);
  if (!p.user) throw new HttpProblem(400, "The service token has no profile; use a personal account");
  return p.user;
}

export function requireAdmin(req: FastifyRequest): Principal {
  const p = requireUser(req);
  if (p.role !== "admin") throw new HttpProblem(403, "Admins only");
  return p;
}

export function sendProblem(reply: FastifyReply, status: number, message: string) {
  return reply.code(status).send({ error: message });
}
