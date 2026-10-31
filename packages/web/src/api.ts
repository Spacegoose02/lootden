import { desktop } from "./desktop";
import type {
  AchievementView,
  Allowance,
  Level,
  PlayerStats,
  PlayLimits,
  TimeRequest,
  WeeklyRecap,
  BrowserPolicy,
  AddonView,
  StoreGame,
  StoreGameDetail,
  ApiTokenInfo,
  AuthProviders,
  EmulatorInfo,
  Platform,
  ServerBiosFile,
  GameDetail,
  GameInfo,
  GameListing,
  GameSummary,
  LibraryStats,
  SaveBackup,
  User,
  UserGameState,
  WorkshopItem,
  WorkshopSettings,
  HelperAccess,
  HelperChatRequest,
  HelperSettings,
  HelperSettingsView,
  HelperStatus,
  HelperUsageReport,
} from "@lootden/shared";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** In the desktop app, a server that stopped answering hands over to the app's offline library. */
let offlineCheck: Promise<unknown> | null = null;
function serverUnreachable(): ApiError {
  if (desktop?.goOffline && !offlineCheck) offlineCheck = desktop.goOffline().catch(() => false).finally(() => setTimeout(() => (offlineCheck = null), 10_000));
  return new ApiError("Can't reach the LootDen server", 0);
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }).catch(() => {
    throw serverUnreachable();
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((data as { error?: string }).error ?? `Request failed (${res.status})`, res.status);
  return data as T;
}

export interface Me {
  user: User | null;
  role: "admin" | "user";
  via: string;
}

export interface HomeData {
  featured: Array<GameSummary & { backgroundUrl: string | null; blurb: string | null }>;
  sections: Array<{ id: string; title: string; games: GameSummary[] }>;
  /** The PC game this person played last, to pick up where they left off. Missing from older servers. */
  resume?: (GameSummary & { backgroundUrl: string | null; blurb: string | null; playtimeSeconds: number; lastPlayedAt: string }) | null;
}

export interface Candidate {
  provider: string;
  providerId: string;
  name: string;
  year: number | null;
  coverUrl: string | null;
  score: number;
}

export interface NewsItem {
  feedId: string;
  feedTitle: string;
  title: string;
  link: string;
  publishedAt: string | null;
  summary: string;
  image: string | null;
}

export interface EmulationOverview {
  platforms: Platform[];
  emulators: EmulatorInfo[];
  /** Systems in the library with game counts. */
  library: Array<{ id: string; count: number; sizeBytes: number }>;
  bios: ServerBiosFile[];
}

export interface GameFilters {
  search?: string;
  genre?: string;
  controller?: string;
  kidSafe?: boolean;
  missingMetadata?: boolean;
  platform?: string;
  /** "update", "dlc" or "addon" (both) list packages instead of games. */
  kind?: string;
  sort?: string;
  order?: string;
}

const qs = (o: Record<string, string | number | boolean | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== "" && v !== false) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

export interface ReleaseRules {
  mustContain: string[];
  mustNotContain: string[];
  preferred: string[];
  minSizeMb: number;
  maxSizeMb: number;
  minSeeders: number;
  preferProtocol: "torrent" | "usenet" | "any";
  blockedIndexers: string[];
}

export type AlertKind = "released" | "found" | "grabbed" | "imported" | "updates" | "flagged" | "sources" | "failed" | "test";

export interface Connectors {
  qbittorrent: { url: string; username: string; password: string; category: string; savePath: string };
  transmission: { url: string; username: string; password: string; category: string; savePath: string };
  deluge: { url: string; password: string; category: string; savePath: string };
  torrentClient: "qbittorrent" | "transmission" | "deluge";
  sabnzbd: { url: string; apiKey: string; category: string };
  prowlarr: { url: string; apiKey: string; categories: number[] };
  import: {
    mode: "copy" | "move" | "off";
    pathMappings: Array<{ from: string; to: string }>;
    tidy: { stripJunk: boolean; extract: boolean; repack: "zip" | "folder"; installers?: boolean };
    folder: string;
    autoImportFolder: boolean;
  };
  itch: { apiKey: string };
  rules: ReleaseRules;
  wanted: { autoSearch: boolean; autoGrab: boolean; intervalHours: number; onlyReleased: boolean };
  notify: { appriseUrl: string; appriseTargets: string } & Record<"released" | "found" | "grabbed" | "imported" | "updates" | "flagged" | "sources" | "requests", boolean>;
  scan: { clamav: "off" | "clamd" | "clamscan"; clamdHost: string; clamdPort: number; virusTotalKey: string; hold: boolean };
  nexus: { apiKey: string };
  hltb: { enabled: boolean };
}

export interface SourceConfig {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  perMinute: number;
  perHour: number;
  extraHosts: string[];
  onMyNetwork: boolean;
  /** The admin's name for the source; "" uses the default name. */
  displayName: string;
}

export interface ReleaseSourceView {
  id: string;
  /** The admin's name for the source when set, else defaultName. */
  name: string;
  defaultName: string;
  /** Whether the source can be given its own name (RSS/Atom and JSON feeds). */
  nameable: boolean;
  description: string;
  needsKey: boolean;
  defaultBaseUrl: string;
  config: SourceConfig;
  status: { lastRunAt: string | null; error: string | null; items: number; usedThisHour: number };
}

export interface SourceRelease {
  id: string;
  source: string;
  sourceName: string;
  title: string;
  date: string | null;
  platform: string | null;
  url: string | null;
  image?: string | null;
  summary?: string | null;
  details?: Record<string, string>;
  /** The source's own links to the release (mirrors), when it gives any. */
  downloads?: Array<{ title?: string | null; uris: string[]; size?: string | null }>;
  seenAt: string;
}

export interface Alert {
  id: number;
  kind: AlertKind;
  title: string;
  body: string | null;
  link: string | null;
  createdAt: string;
  read: boolean;
}

export interface ScanRecord {
  id: number;
  name: string;
  path: string;
  heldPath: string | null;
  status: "clean" | "flagged" | "error" | "released" | "deleted";
  findings: Array<{ file: string; threat: string; engine: string }>;
  scannedAt: string;
}

export interface VersionCheck {
  gameId: string;
  current: string | null;
  latest: string | null;
  source: "gog" | "steam" | "itch" | null;
  detail: string | null;
  url: string | null;
  behind: boolean;
  checkedAt: string;
}

/** A game someone asked for (see the server's news/requests.ts). */
export interface GameRequest {
  id: number;
  title: string;
  url: string | null;
  image: string | null;
  steamAppId: number | null;
  note: string | null;
  status: "pending" | "declined" | "searching" | "downloading" | "ready";
  requestedBy: { id: number; name: string };
  createdAt: string;
  decidedAt: string | null;
  reason: string | null;
  libraryId: string | null;
}

export const BACKLOG = ["backlog", "playing", "done", "shelved", "dropped", "wishlist"] as const;
export type BacklogStatus = (typeof BACKLOG)[number];
export const BACKLOG_LABELS: Record<BacklogStatus, string> = { backlog: "Backlog", playing: "Playing", done: "Finished", shelved: "On hold", dropped: "Dropped", wishlist: "Want to play" };

export interface Journal {
  gameId: string;
  status: BacklogStatus | null;
  rating: number | null;
  notes: string;
  entries: Array<{ id: number; text: string; createdAt: string }>;
  updatedAt: string | null;
}

export interface TimeToBeat {
  main: number | null;
  normally: number | null;
  completely: number | null;
  count: number;
  /** Missing from servers before HowLongToBeat support (always IGDB then). */
  source?: "hltb" | "igdb";
  url?: string;
}

export interface NexusMod {
  id: number;
  name: string;
  summary: string;
  picture: string | null;
  author: string;
  endorsements: number;
  url: string;
}

export interface LibraryStatsDetail {
  gameCount: number;
  totalBytes: number;
  averageRating: number | null;
  controller: { full: number; partial: number };
  kidSafe: number;
  platforms: Array<{ id: string; name: string; count: number; bytes: number }>;
  genres: Array<{ name: string; count: number }>;
  releaseYears: Array<{ from: number; count: number }>;
  addedByMonth: Array<{ month: string; count: number }>;
  playtime: Array<{ name: string; seconds: number }>;
  mostPlayed: Array<{ id: string; title: string; seconds: number }>;
  biggest: Array<{ id: string; title: string; bytes: number }>;
  backlog: Record<BacklogStatus, number> | null;
}

export interface BacklogData {
  items: Array<{ gameId: string; status: BacklogStatus; rating: number | null; updatedAt: string; game: GameSummary; playtimeSeconds: number }>;
  counts: Record<BacklogStatus, number>;
  unsorted: number;
}

export interface FolderItem {
  name: string;
  sizeBytes: number;
  modifiedAt: string;
  settling: boolean;
  status: "new" | "importing" | "imported" | "failed" | "skipped";
  target: string | null;
  error: string | null;
  progress: ImportProgress | null;
}

export interface FreeGame {
  store: "epic" | "steam" | "gog" | "itch" | "prime";
  title: string;
  url: string;
  image: string | null;
  endsAt: string | null;
  startsAt: string | null;
  upcoming: boolean;
  kind: "giveaway" | "free";
  canAdd: boolean;
}

export interface GameUpdate {
  title: string;
  date: string;
  url: string;
  body: string;
  patchNotes: boolean;
}

export interface SearchResult {
  guid: string;
  title: string;
  sizeBytes: number;
  indexer: string;
  protocol: "torrent" | "usenet";
  downloadUrl: string;
  infoUrl: string | null;
  seeders: number | null;
  leechers: number | null;
  publishedAt: string | null;
  allowed?: boolean;
  reason?: string | null;
  best?: boolean;
}

export interface LiveDownload {
  client: string;
  id: string;
  name: string;
  sizeBytes: number;
  progress: number;
  downloadSpeed: number;
  etaSeconds: number | null;
  state: string;
  path: string | null;
}

export interface DownloadRecord {
  id: number;
  client: string;
  name: string;
  addedAt: string;
  status: string;
  importedPath: string | null;
  error: string | null;
  live: LiveDownload | null;
  progress?: ImportProgress | null;
}

export interface ImportProgress {
  stage: "copying" | "unpacking" | "installing" | "cleaning" | "zipping";
  percent: number | null;
}

export type WishSource = { kind: "steam" | "manual"; name: string } | { kind: "feed"; id: number; name: string };
export interface WishItem {
  id: number;
  title: string;
  steamAppId: number | null;
  url: string | null;
  image: string | null;
  releaseDate: string | null;
  dateText: string | null;
  sources: WishSource[];
  addedAt: string;
  libraryId: string | null;
  monitored: boolean;
  searchedAt: string | null;
  found: { title: string; indexer: string; sizeBytes: number; protocol: "torrent" | "usenet"; seeders: number | null; url: string } | null;
  downloadId: number | null;
}
export interface WishFeed {
  id: number;
  url: string;
  name: string;
  checkedAt: string | null;
  error: string | null;
  itemCount: number;
}
export interface WishlistState {
  items: WishItem[];
  steam: { steamId: string; profile: string; syncedAt: string | null; error: string | null; count: number; autoSync?: boolean } | null;
  feeds: WishFeed[];
}

export interface Integrations {
  settings: {
    publicUrl: string;
    igdb: { clientId: string; clientSecret: string };
    rawg: { apiKey: string };
    steamgriddb: { apiKey: string };
    screenscraper: { devId: string; devPassword: string; username: string; password: string };
    thegamesdb: { apiKey: string };
    launchbox: { enabled: boolean };
    metadataOrder: { pc: MetadataSourceEntry[]; emulated: MetadataSourceEntry[] };
    oidc: { issuer: string; clientId: string; clientSecret: string; name: string; adminGroup: string; autoCreate: boolean };
  };
  fromEnvironment: string[];
  callbackUrl: string | null;
  /** Metadata sources that have their keys (or need none). */
  ready: string[];
}

export interface MetadataSourceEntry {
  id: string;
  on: boolean;
}

export interface ArtworkOption {
  url: string;
  thumb: string;
  width: number;
  height: number;
  source: string;
}

export interface ClientFile {
  name: string;
  size: number;
  modifiedAt: string;
  platform: "windows" | "linux" | "playnite" | "other";
  kind: string;
}

export interface ListingResult {
  source: string;
  items: GameListing[];
}

export interface Video {
  id: string;
  title: string;
  url: string;
  thumbnail: string;
  channel: string;
  publishedAt: string | null;
}

export interface VideoGroup {
  id: string;
  title: string;
  intervalMinutes: number;
  channels: Array<{ id: string; name: string }>;
}

/** A store game's address on the server. Games only found on this PC send their title along. */
export const storeGamePath = (addon: string, id: string) => `/api/store-games/${encodeURIComponent(addon)}/${encodeURIComponent(id)}`;
const titleQuery = (title: string) => (title ? `?title=${encodeURIComponent(title)}` : "");

async function upload<T>(method: string, path: string, body: Blob, contentType: string): Promise<T> {
  const res = await fetch(path, { method, credentials: "same-origin", headers: { "Content-Type": contentType }, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((data as { error?: string }).error ?? `Upload failed (${res.status})`, res.status);
  return data as T;
}

/** Download Manager: a game fetched from file-host links. */
export interface DirectFile {
  id: number;
  url: string;
  host: string;
  fileName: string | null;
  sizeBytes: number | null;
  receivedBytes: number;
  status: "queued" | "downloading" | "done" | "failed";
  error: string | null;
}

export interface DirectPackage {
  id: number;
  name: string;
  platform: string | null;
  status: "queued" | "downloading" | "paused" | "importing" | "imported" | "failed";
  error: string | null;
  importedPath: string | null;
  addedAt: string;
  finishedAt: string | null;
  files: DirectFile[];
  speed: number | null;
  progress: ImportProgress | null;
}

export interface LinkCheck {
  url: string;
  host: string;
  ok: boolean;
  fileName: string | null;
  sizeBytes: number | null;
  error: string | null;
}

export const api = {
  providers: () => call<AuthProviders>("GET", "/api/auth/providers"),
  setup: (username: string, password: string) => call<User>("POST", "/api/auth/setup", { username, password }),
  login: (username: string, password: string) => call<{ user: User }>("POST", "/api/auth/login", { username, password }),
  logout: () => call("POST", "/api/auth/logout"),
  me: () => call<Me>("GET", "/api/me"),
  updateMe: (patch: { displayName?: string; avatar?: string }) => call<User>("PATCH", "/api/me", patch),
  changePassword: (currentPassword: string, newPassword: string) => call("POST", "/api/me/password", { currentPassword, newPassword }),
  tokens: () => call<ApiTokenInfo[]>("GET", "/api/me/tokens"),
  createToken: (name: string) => call<{ id: number; token: string }>("POST", "/api/me/tokens", { name }),
  revokeToken: (id: number) => call("DELETE", `/api/me/tokens/${id}`),
  myGames: () => call<UserGameState[]>("GET", "/api/me/games"),

  home: () => call<HomeData>("GET", "/api/home"),
  games: (f: GameFilters = {}) => call<GameSummary[]>("GET", `/api/games${qs({ ...f })}`),
  platforms: () => call<Array<{ id: string; count: number; sizeBytes: number }>>("GET", "/api/platforms"),
  genres: (platform?: string) => call<Array<{ name: string; count: number }>>("GET", `/api/genres${qs({ platform })}`),
  freeGames: () => call<{ games: FreeGame[]; errors: Array<{ store: string; message: string }>; itchConnected: boolean }>("GET", "/api/discover/free"),
  addItchGame: (url: string) => call<{ folder: string }>("POST", "/api/discover/free/itch", { url }),
  gameUpdates: (id: string) => call<{ source: string | null; items: GameUpdate[]; error?: string }>("GET", `/api/games/${id}/updates`),
  downloadsFolder: () => call<{ folder: string; items: FolderItem[] }>("GET", "/api/downloads/folder"),
  importFromFolder: (name: string, platform: string | null) => call<{ target: string }>("POST", "/api/downloads/folder/import", { name, platform }),
  skipFolderItem: (name: string) => call("POST", "/api/downloads/folder/skip", { name }),
  emulation: () => call<EmulationOverview>("GET", "/api/emulation"),
  uploadBios: (file: File, emulator?: string) =>
    upload<ServerBiosFile>("PUT", `/api/emulation/bios/${encodeURIComponent(file.name)}${emulator ? `?emulator=${emulator}` : ""}`, file, "application/octet-stream"),
  deleteBios: (name: string) => call("DELETE", `/api/emulation/bios/${encodeURIComponent(name)}`),
  game: (id: string) => call<GameDetail>("GET", `/api/games/${id}`),
  setPackage: (id: string, patch: { kind?: string | null; baseGameId?: string | null }) => call<GameDetail>("PUT", `/api/games/${id}/package`, patch),
  deleteGame: (id: string, permanent = false) => call<{ deleted: string }>("DELETE", `/api/games/${id}${permanent ? "?permanent=true" : ""}`),
  updateGame: (id: string, patch: { title?: string | null; kidSafe?: boolean | null; controllerSupport?: string | null }) =>
    call<GameDetail>("PATCH", `/api/games/${id}`, patch),
  searchMetadata: (id: string, q: string) => call<Candidate[]>("GET", `/api/games/${id}/metadata/search${qs({ q })}`),
  applyMetadata: (id: string, provider: string, providerId: string) => call<GameDetail>("PUT", `/api/games/${id}/metadata`, { provider, providerId }),
  clearMetadata: (id: string) => call("DELETE", `/api/games/${id}/metadata`),
  refreshGameMetadata: (id: string) => call<GameDetail>("POST", `/api/games/${id}/metadata/refresh`),

  stats: () => call<LibraryStats>("GET", "/api/library/stats"),
  rescan: () => call<LibraryStats>("POST", "/api/library/rescan"),
  metadataStatus: () => call<{ providers: string[]; queued: number; running: boolean; matched: number; unmatched: number }>("GET", "/api/metadata/status"),
  refreshMetadata: (force = false) => call<{ queued: number }>("POST", "/api/metadata/refresh", { force }),
  /** Looks matched games up again too: "all", "pc", "emulated" or one system's id. */
  refreshAllMetadata: (scope: string) => call<{ queued: number }>("POST", "/api/metadata/refresh", { scope }),

  users: () => call<User[]>("GET", "/api/users"),
  userBrowser: (id: number) => call<BrowserPolicy>("GET", `/api/users/${id}/browser`),
  saveUserBrowser: (id: number, p: Partial<BrowserPolicy>) => call<BrowserPolicy>("PUT", `/api/users/${id}/browser`, p),
  createUser: (u: { username: string; password?: string; displayName?: string; role?: string; kidMode?: boolean }) => call<User>("POST", "/api/users", u),
  updateUser: (id: number, patch: Partial<{ displayName: string; role: string; kidMode: boolean; password: string | null }>) =>
    call<User>("PATCH", `/api/users/${id}`, patch),
  deleteUser: (id: number) => call("DELETE", `/api/users/${id}`),

  // Bandit, the AI helper.
  helperStatus: () => call<HelperStatus>("GET", "/api/me/helper"),
  setHelperEnabled: (enabled: boolean) => call<HelperStatus>("PUT", "/api/me/helper", { enabled }),
  helperSettings: () => call<HelperSettingsView>("GET", "/api/helper/settings"),
  saveHelperSettings: (patch: Partial<HelperSettings>) => call<HelperSettingsView>("PUT", "/api/helper/settings", patch),
  helperUsage: () => call<HelperUsageReport>("GET", "/api/helper/usage"),
  userHelper: (id: number) => call<HelperAccess>("GET", `/api/users/${id}/helper`),
  saveUserHelper: (id: number, patch: { allowed?: boolean | null; dailyLimit?: number | null }) => call<HelperAccess>("PUT", `/api/users/${id}/helper`, patch),

  connectors: () => call<Connectors>("GET", "/api/connectors"),
  saveConnectors: (c: Partial<Connectors>) => call<Connectors>("PUT", "/api/connectors", c),
  testConnector: (name: string) => call<{ message: string }>("POST", `/api/connectors/${name}/test`),
  searchDownloads: (q: string) => call<SearchResult[]>("GET", `/api/downloads/search${qs({ q })}`),
  grab: (r: { url: string; title: string; protocol: string; platform?: string | null }) => call<DownloadRecord>("POST", "/api/downloads", r),
  downloads: () => call<{ downloads: DownloadRecord[]; other: LiveDownload[] }>("GET", "/api/downloads"),
  controlDownload: (id: number, action: string, deleteFiles = false) => call("POST", `/api/downloads/${id}`, { action, deleteFiles }),
  directDownloads: () => call<{ hosts: string[]; packages: DirectPackage[] }>("GET", "/api/direct"),
  checkLinks: (links: string) => call<LinkCheck[]>("POST", "/api/direct/check", { links }),
  addLinks: (b: { links: string; name?: string; platform?: string | null }) => call<DirectPackage>("POST", "/api/direct", b),
  controlDirect: (id: number, action: "pause" | "resume" | "retry" | "remove") => call("POST", `/api/direct/${id}`, { action }),

  news: () => call<{ items: NewsItem[]; errors: Array<{ feedId: string; error: string }> }>("GET", "/api/news"),
  integrations: () => call<Integrations>("GET", "/api/settings/integrations"),
  saveIntegrations: (s: Partial<Integrations["settings"]>) => call<Integrations>("PUT", "/api/settings/integrations", s),
  testIntegration: (name: string) => call<{ message: string }>("POST", `/api/settings/integrations/${name}/test`),

  artworkOptions: (id: string, kind: string, q = "") => call<ArtworkOption[]>("GET", `/api/games/${id}/artwork/${kind}${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  setArtworkUrl: (id: string, kind: string, url: string) => call<GameDetail>("PUT", `/api/games/${id}/artwork/${kind}`, { url }),
  uploadArtwork: (id: string, kind: string, file: File) => upload<GameDetail>("PUT", `/api/games/${id}/artwork/${kind}`, file, file.type || "image/jpeg"),
  resetArtwork: (id: string, kind: string) => call<GameDetail>("DELETE", `/api/games/${id}/artwork/${kind}`),

  clients: () => call<ClientFile[]>("GET", "/api/clients"),
  uploadClient: (file: File) => upload<ClientFile>("PUT", `/api/clients/${encodeURIComponent(file.name)}`, file, "application/octet-stream"),
  deleteClient: (name: string) => call("DELETE", `/api/clients/${encodeURIComponent(name)}`),
  clientSource: () => call<{ repo: string; tag: string; fetchedAt: string; checkedAt: string | null } | null>("GET", "/api/clients/source"),
  fetchRelease: (repo: string) => call<{ tag: string; files: string[] }>("POST", "/api/clients/github", { repo }),

  saves: (id: string) => call<SaveBackup[]>("GET", `/api/games/${id}/saves`),
  uploadSave: (id: string, file: File) => upload<SaveBackup>("POST", `/api/games/${id}/saves?device=${encodeURIComponent("Web upload")}`, file, "application/octet-stream"),
  deleteSave: (id: string, saveId: number) => call("DELETE", `/api/games/${id}/saves/${saveId}`),
  setSavePath: (id: string, path: string | null) => call<GameDetail>("PUT", `/api/games/${id}/save-path`, { path }),
  suggestSavePath: (id: string) => call<{ paths: string[] }>("GET", `/api/games/${id}/save-path/suggest`),

  calendar: (days = 120, platform = "pc", past = 0) => call<ListingResult & { error?: string }>("GET", `/api/calendar${qs({ days: String(days), platform, past: String(past) })}`),
  addCalendarEntry: (e: { title: string; date: string; note?: string; url?: string }) => call<{ id: number }>("POST", "/api/calendar/entries", e),
  deleteCalendarEntry: (id: string) => call("DELETE", `/api/calendar/entries/${id}`),
  requests: () => call<GameRequest[]>("GET", "/api/requests"),
  requestGame: (r: { title: string; url?: string | null; image?: string | null; steamAppId?: number | null; note?: string | null }) => call<GameRequest>("POST", "/api/requests", r),
  approveRequest: (id: number) => call<GameRequest>("POST", `/api/requests/${id}/approve`),
  declineRequest: (id: number, reason: string) => call<GameRequest>("POST", `/api/requests/${id}/decline`, { reason }),
  withdrawRequest: (id: number) => call("DELETE", `/api/requests/${id}`),
  wishlist: () => call<WishlistState>("GET", "/api/wishlist"),
  addWish: (title: string, url?: string) => call<WishlistState>("POST", "/api/wishlist", { title, url }),
  removeWish: (id: number) => call<WishlistState>("DELETE", `/api/wishlist/${id}`),
  syncWishlist: () => call<WishlistState>("POST", "/api/wishlist/sync"),
  linkSteamWishlist: (profile: string, autoSync?: boolean) => call<WishlistState>("PUT", "/api/wishlist/steam", { profile, autoSync }),
  setSteamAutoSync: (autoSync: boolean) => call<WishlistState>("PUT", "/api/wishlist/steam/auto", { autoSync }),
  setMonitored: (id: number, monitored: boolean) => call<WishlistState>("PUT", `/api/wishlist/${id}`, { monitored }),
  searchWanted: (id: number) => call<WishlistState & { found: WishItem["found"] }>("POST", `/api/wishlist/${id}/search`),
  grabWanted: (id: number) => call<WishlistState>("POST", `/api/wishlist/${id}/grab`),
  runWanted: () => call("POST", "/api/wanted/run"),

  alerts: () => call<{ alerts: Alert[]; unread: number }>("GET", "/api/alerts"),
  readAlerts: () => call("POST", "/api/alerts/read"),
  testAlert: () => call<{ message: string }>("POST", "/api/alerts/test"),
  scans: () => call<ScanRecord[]>("GET", "/api/scans"),
  decideScan: (id: number, action: "release" | "delete") => call<ScanRecord[]>("POST", `/api/scans/${id}`, { action }),
  testScanner: () => call<{ message: string }>("POST", "/api/scans/test"),
  updatesBehind: () => call<Array<VersionCheck & { title: string }>>("GET", "/api/updates"),
  version: (id: string) => call<VersionCheck | null>("GET", `/api/games/${id}/version`),
  checkVersion: (id: string) => call<VersionCheck>("POST", `/api/games/${id}/version`),
  journal: (id: string) => call<Journal>("GET", `/api/games/${id}/journal`),
  saveJournal: (id: string, patch: { status?: BacklogStatus | null; rating?: number | null; notes?: string }) => call<Journal>("PUT", `/api/games/${id}/journal`, patch),
  addJournalEntry: (id: string, text: string) => call<Journal>("POST", `/api/games/${id}/journal/entries`, { text }),
  deleteJournalEntry: (entryId: number) => call("DELETE", `/api/journal/entries/${entryId}`),
  backlog: () => call<BacklogData>("GET", "/api/backlog"),
  roulette: (status = "backlog", controller = false) => call<{ game: GameSummary; from: string; poolSize: number }>("GET", `/api/backlog/roulette${qs({ status, controller: controller ? "1" : undefined })}`),
  timeToBeat: (id: string) => call<TimeToBeat | null>("GET", `/api/games/${id}/time-to-beat`),
  mods: (id: string) => call<{ configured: boolean; domain: string | null; mods: NexusMod[] }>("GET", `/api/games/${id}/mods`),
  workshop: (id: string) => call<WorkshopSettings>("GET", `/api/games/${id}/workshop`),
  saveWorkshop: (id: string, body: { appId: string | null; modsPath: string }) => call<WorkshopSettings>("PUT", `/api/games/${id}/workshop`, body),
  workshopItems: (id: string, q = "", page = 1) => call<{ items: WorkshopItem[]; total: number }>("GET", `/api/games/${id}/workshop/items?q=${encodeURIComponent(q)}&page=${page}`),
  workshopLinks: (id: string, links: string) => call<{ items: WorkshopItem[]; total: number }>("GET", `/api/games/${id}/workshop/items?ids=${encodeURIComponent(links)}`),
  /** A game bought on Steam: browse its Workshop here, subscribe on Steam. */
  steamWorkshop: (appId: string) => call<WorkshopSettings>("GET", `/api/store-games/steam/${appId}/workshop`),
  steamWorkshopItems: (appId: string, q = "", page = 1) => call<{ items: WorkshopItem[]; total: number }>("GET", `/api/store-games/steam/${appId}/workshop/items?q=${encodeURIComponent(q)}&page=${page}`),
  steamWorkshopLinks: (appId: string, links: string) => call<{ items: WorkshopItem[]; total: number }>("GET", `/api/store-games/steam/${appId}/workshop/items?ids=${encodeURIComponent(links)}`),
  testNexus: () => call<{ message: string }>("POST", "/api/mods/test"),
  sources: () => call<ReleaseSourceView[]>("GET", "/api/sources"),
  // Library add-ons: this person's store accounts and the games they own there.
  addons: () => call<AddonView[]>("GET", "/api/addons"),
  connectAddon: (id: string, config: Record<string, string>) => call<{ games: number; addons: AddonView[] }>("PUT", `/api/addons/${id}/account`, { config }),
  syncAddon: (id: string) => call<{ games: number; addons: AddonView[] }>("POST", `/api/addons/${id}/sync`),
  disconnectAddon: (id: string) => call<AddonView[]>("DELETE", `/api/addons/${id}/account`),
  setAddonShared: (id: string, config: Record<string, string>) => call<AddonView[]>("PUT", `/api/addons/${id}/shared`, { config }),
  addonSignIn: (start: string) => call<{ url: string }>("POST", start),
  setAddonEnabled: (id: string, enabled: boolean) => call<AddonView[]>("PUT", `/api/addons/${id}`, { enabled }),
  storeGames: (addon?: string) => call<StoreGame[]>("GET", `/api/store-games${addon ? `?addon=${encodeURIComponent(addon)}` : ""}`),
  /** Titles and covers this person set on store games, for ones only found on this PC. */
  storeGamesCustom: () => call<Array<{ addon: string; externalId: string; title: string | null; coverUrl: string | null }>>("GET", "/api/store-games/custom"),
  storeGame: (addon: string, id: string, title = "") => call<StoreGameDetail>("GET", `${storeGamePath(addon, id)}${titleQuery(title)}`),
  updateStoreGame: (addon: string, id: string, patch: { title?: string | null; match?: { provider: string; providerId: string } | null }, title = "") =>
    call<StoreGameDetail>("PUT", `${storeGamePath(addon, id)}${titleQuery(title)}`, patch),
  refreshStoreGame: (addon: string, id: string, title = "") => call<StoreGameDetail>("POST", `${storeGamePath(addon, id)}/refresh${titleQuery(title)}`),
  storeGameMatches: (addon: string, id: string, q: string, title = "") => call<GameListing[]>("GET", `${storeGamePath(addon, id)}/matches?q=${encodeURIComponent(q)}${title ? `&title=${encodeURIComponent(title)}` : ""}`),
  storeArtworkOptions: (addon: string, id: string, kind: string, q = "", title = "") =>
    call<ArtworkOption[]>("GET", `${storeGamePath(addon, id)}/artwork/${kind}?q=${encodeURIComponent(q)}${title ? `&title=${encodeURIComponent(title)}` : ""}`),
  setStoreArtworkUrl: (addon: string, id: string, kind: string, url: string, title = "") => call<StoreGameDetail>("PUT", `${storeGamePath(addon, id)}/artwork/${kind}${titleQuery(title)}`, { url }),
  uploadStoreArtwork: (addon: string, id: string, kind: string, file: File, title = "") =>
    upload<StoreGameDetail>("PUT", `${storeGamePath(addon, id)}/artwork/${kind}${titleQuery(title)}`, file, file.type || "image/jpeg"),
  resetStoreArtwork: (addon: string, id: string, kind: string, title = "") => call<StoreGameDetail>("DELETE", `${storeGamePath(addon, id)}/artwork/${kind}${titleQuery(title)}`),
  pairingCode: () => call<{ code: string; expiresAt: string }>("POST", "/api/auth/pair"),
  redeemPairingCode: (code: string) => call<{ user: User }>("POST", "/api/auth/pair/redeem", { code }),
  saveSource: (id: string, c: Partial<SourceConfig>) => call<ReleaseSourceView>("PUT", `/api/sources/${id}`, c),
  testSource: (id: string) => call<{ message: string; sources: ReleaseSourceView[] }>("POST", `/api/sources/${id}/test`),
  sourceReleases: (limit = 40) => call<SourceRelease[]>("GET", `/api/sources/latest${qs({ limit: String(limit) })}`),
  downloadSourceRelease: (id: string, uri?: string) => call<{ via: "direct" | "torrent"; message: string }>("POST", "/api/sources/download", { id, uri }),
  libraryStats: () => call<LibraryStatsDetail>("GET", "/api/stats/library"),
  addWishFeed: (url: string, name?: string) => call<WishlistState>("POST", "/api/wishlist/feeds", { url, name }),
  removeWishFeed: (id: number) => call<WishlistState>("DELETE", `/api/wishlist/feeds/${id}`),
  discover: () => call<{ recent: ListingResult }>("GET", "/api/discover"),
  discoverGame: (provider: string, id: string) => call<GameInfo>("GET", `/api/discover/game/${provider}/${id}`),
  discoverSearch: (q: string) => call<GameListing[]>("GET", `/api/discover/search${qs({ q })}`),
  videos: () => call<{ groups: Array<{ id: string; title: string; videos: Video[] }>; errors: string[] }>("GET", "/api/videos"),
  videoGroups: () => call<VideoGroup[]>("GET", "/api/videos/groups"),
  saveVideoGroups: (groups: Array<{ id?: string; title: string; intervalMinutes: number; channels: string[] }>) =>
    call<VideoGroup[]>("PUT", "/api/videos/groups", { groups }),

  feeds: () => call<Array<{ id: string; url: string; title: string }>>("GET", "/api/news/feeds"),
  addFeed: (url: string, title?: string) => call("POST", "/api/news/feeds", { url, title }),
  removeFeed: (id: string) => call("DELETE", `/api/news/feeds/${id}`),

  // Family: play time, bonus time, achievements, celebrations, the weekly recap and shelves.
  allowance: () => call<Allowance & { limits: PlayLimits }>("GET", "/api/me/allowance"),
  familySettings: () => call<FamilySettings>("GET", "/api/family/settings"),
  saveFamilySettings: (patch: Partial<Pick<FamilySettings, "timeZone" | "separateSaves">>) => call<FamilySettings>("PUT", "/api/family/settings", patch),
  userLimits: (id: number) => call<{ limits: PlayLimits; allowance: Allowance }>("GET", `/api/users/${id}/limits`),
  saveUserLimits: (id: number, limits: PlayLimits) => call<{ limits: PlayLimits; allowance: Allowance }>("PUT", `/api/users/${id}/limits`, limits),
  giveTime: (id: number, minutes: number) => call<{ limits: PlayLimits; allowance: Allowance }>("POST", `/api/users/${id}/bonus`, { minutes }),
  timeRequests: () => call<TimeRequest[]>("GET", "/api/time-requests"),
  askForTime: (minutes: number, note: string | null) => call<TimeRequest>("POST", "/api/time-requests", { minutes, note }),
  approveTime: (id: number, minutes?: number) => call<TimeRequest>("POST", `/api/time-requests/${id}/approve`, minutes ? { minutes } : {}),
  declineTime: (id: number) => call<TimeRequest>("POST", `/api/time-requests/${id}/decline`),
  progress: () => call<Progress>("GET", "/api/me/progress"),
  playerCard: (id: number) => call<PlayerCard>("GET", `/api/users/${id}/card`),
  celebrations: () => call<Celebrations>("GET", "/api/me/celebrations"),
  /** Marks the celebrations a screen showed as seen (ids), so ones that arrived meanwhile still get theirs. */
  celebrated: (c: Celebrations) => call("POST", "/api/me/celebrations/seen", { achievements: c.achievements.map((a) => a.id), wishes: c.wishes.map((w) => w.id), bonus: c.bonus.map((b) => b.id) }),
  spun: () => call<{ spins: number }>("POST", "/api/me/roulette"),
  recap: (weeksAgo = 0) => call<WeeklyRecap>("GET", `/api/family/recap${qs({ weeksAgo: weeksAgo || undefined })}`),
  shelves: () => call<Shelf[]>("GET", "/api/shelves"),
  createShelf: (s: ShelfInput) => call<Shelf>("POST", "/api/shelves", s),
  updateShelf: (id: number, s: ShelfInput) => call<Shelf>("PATCH", `/api/shelves/${id}`, s),
  deleteShelf: (id: number) => call("DELETE", `/api/shelves/${id}`),
  shelveGame: (id: number, gameId: string) => call<Shelf>("PUT", `/api/shelves/${id}/games/${encodeURIComponent(gameId)}`),
  unshelveGame: (id: number, gameId: string) => call<Shelf>("DELETE", `/api/shelves/${id}/games/${encodeURIComponent(gameId)}`),
  gameShelves: (gameId: string) => call<number[]>("GET", `/api/games/${encodeURIComponent(gameId)}/shelves`),
  setTogether: (id: string, together: string[] | null) => call<GameDetail>("PATCH", `/api/games/${id}`, { together }),
};

export interface FamilySettings {
  timeZone: string;
  separateSaves: boolean;
  /** The time zone in use: the one set, else the server's. */
  effectiveTimeZone: string;
}

export interface Progress {
  level: Level;
  stats: PlayerStats;
  achievements: AchievementView[];
}

export interface PlayerCard {
  id: number;
  displayName: string;
  avatar: string;
  kid: boolean;
  level: Level;
  achievements: AchievementView[];
}

export interface Celebrations {
  achievements: AchievementView[];
  wishes: Array<{ id: number; title: string; image: string | null; gameId: string }>;
  bonus: Array<{ id: number; minutes: number }>;
}

export interface Shelf {
  id: number;
  name: string;
  emoji: string | null;
  description: string | null;
  household: boolean;
  onHome: boolean;
  ownerId: number | null;
  mine: boolean;
  games: GameSummary[];
}

export type ShelfInput = Partial<Pick<Shelf, "name" | "emoji" | "description" | "household" | "onHome">>;

/** "1 h 20 min", "45 min": for play time left and limits. */
export function formatMinutes(seconds: number): string {
  const m = Math.max(0, Math.round(seconds / 60));
  if (m < 60) return `${m} min`;
  return m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`;
}

export const avatarUrl = (seed: string) => `/api/avatars/${encodeURIComponent(seed)}.svg`;

export function formatBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatPlaytime(seconds: number): string {
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}

/**
 * Asks Bandit, calling onText with each piece of the answer as it arrives. Problems before the
 * answer starts come back as an ApiError with the server's words.
 */
export async function askHelper(req: HelperChatRequest, onText: (text: string) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch("/api/helper/chat", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
    signal,
  }).catch((err: unknown) => {
    if (signal?.aborted) throw err;
    throw new ApiError("Can't reach the LootDen server", 0);
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status);
  }
  const reader = res.body?.getReader();
  if (!reader) return onText(await res.text());
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onText(decoder.decode(value, { stream: true }));
  }
  const rest = decoder.decode();
  if (rest) onText(rest);
}
