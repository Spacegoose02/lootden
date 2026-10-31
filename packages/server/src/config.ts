import path from "node:path";
import { DEFAULT_ORDER } from "./metadata/sources.js";

export interface ServerConfig {
  host: string;
  port: number;
  /** Folder that holds the games. Read-only access is enough. */
  gamesDir: string;
  /** Writable folder for the database and cached images. */
  dataDir: string;
  /** Public base URL (https://games.example.com). Needed for OIDC redirects and secure cookies. */
  publicUrl: string;
  /** Optional service token with admin rights (scripts, the first client before accounts exist). */
  apiToken: string;
  /** Encrypts store accounts' keys in the database; empty means a random key kept in <data>/secret.key. */
  secretKey: string;
  /** Minutes between automatic rescans; 0 turns periodic rescans off. */
  scanIntervalMinutes: number;
  /** React to file changes in the games folder. */
  watch: boolean;
  logLevel: string;
  admin: { username: string; password: string };
  oidc: {
    issuer: string;
    clientId: string;
    clientSecret: string;
    /** Button label on the login page. */
    name: string;
    scopes: string;
    /** Create accounts on first OIDC login. */
    autoCreate: boolean;
    /** Members of this group (from the "groups" claim) become admins. */
    adminGroup: string;
  };
  /** Trusted reverse-proxy login (TinyAuth, Authelia, Authentik forward auth). */
  headerAuth: {
    userHeader: string;
    emailHeader: string;
    nameHeader: string;
    groupsHeader: string;
    /** Only requests from these addresses may use the headers. */
    trustedProxies: string[];
    adminGroup: string;
  };
  igdb: { clientId: string; clientSecret: string };
  /** RAWG.io metadata (free key from rawg.io/apidocs). */
  rawg: { apiKey: string };
  /** SteamGridDB artwork (free key from steamgriddb.com). */
  steamgriddb: { apiKey: string };
  /** ScreenScraper.fr: developer credentials (required) and the user's own account (optional, raises the daily quota). */
  screenscraper: { devId: string; devPassword: string; username: string; password: string };
  /** TheGamesDB.net (free key from the forums.thegamesdb.net API key thread). */
  thegamesdb: { apiKey: string };
  /** LaunchBox Games Database: no key, the whole database is downloaded and searched locally. */
  launchbox: { enabled: boolean };
  /** Metadata sources to try, in order, for PC and for emulated games. */
  metadataOrder: { pc: string[]; emulated: string[] };
  /** Look up metadata automatically for new games. */
  metadataAuto: boolean;
  /** Bandit, the AI gaming helper: an Anthropic API key from the environment (the admin can also paste one in Settings). */
  anthropicApiKey: string;
}

function int(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n < 0) throw new Error(`Expected a non-negative integer, got "${value}"`);
  return n;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

/**
 * Settings come from LOOTDEN_* variables. The GM_* names from before the rename still work;
 * when both are set, LOOTDEN_* wins.
 */
export function withLegacyEnv(raw: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...raw };
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith("LOOTDEN_") && value !== undefined) env[`GM_${key.slice("LOOTDEN_".length)}`] = value;
  }
  return env;
}

export function loadConfig(rawEnv: NodeJS.ProcessEnv = process.env): ServerConfig {
  const env = withLegacyEnv(rawEnv);
  return {
    host: env.GM_HOST || "0.0.0.0",
    port: int(env.GM_PORT, 8080),
    gamesDir: path.resolve(env.GM_GAMES_DIR || "/games"),
    dataDir: path.resolve(env.GM_DATA_DIR || "/data"),
    publicUrl: (env.GM_PUBLIC_URL || "").replace(/\/+$/, ""),
    apiToken: env.GM_API_TOKEN || "",
    secretKey: env.GM_SECRET_KEY || "",
    scanIntervalMinutes: int(env.GM_SCAN_INTERVAL_MINUTES, 30),
    watch: bool(env.GM_WATCH, true),
    logLevel: env.GM_LOG_LEVEL || "info",
    admin: { username: env.GM_ADMIN_USERNAME || "", password: env.GM_ADMIN_PASSWORD || "" },
    oidc: {
      issuer: env.GM_OIDC_ISSUER || "",
      clientId: env.GM_OIDC_CLIENT_ID || "",
      clientSecret: env.GM_OIDC_CLIENT_SECRET || "",
      name: env.GM_OIDC_NAME || "Single sign-on",
      scopes: env.GM_OIDC_SCOPES || "openid profile email groups",
      autoCreate: bool(env.GM_OIDC_AUTO_CREATE, true),
      adminGroup: env.GM_OIDC_ADMIN_GROUP || "",
    },
    headerAuth: {
      userHeader: (env.GM_AUTH_HEADER_USER || "").toLowerCase(),
      emailHeader: (env.GM_AUTH_HEADER_EMAIL || "remote-email").toLowerCase(),
      nameHeader: (env.GM_AUTH_HEADER_NAME || "remote-name").toLowerCase(),
      groupsHeader: (env.GM_AUTH_HEADER_GROUPS || "remote-groups").toLowerCase(),
      trustedProxies: (env.GM_TRUSTED_PROXIES || "").split(",").map((s) => s.trim()).filter(Boolean),
      adminGroup: env.GM_AUTH_HEADER_ADMIN_GROUP || "",
    },
    igdb: { clientId: env.GM_IGDB_CLIENT_ID || "", clientSecret: env.GM_IGDB_CLIENT_SECRET || "" },
    rawg: { apiKey: env.GM_RAWG_API_KEY || "" },
    steamgriddb: { apiKey: env.GM_STEAMGRIDDB_API_KEY || "" },
    screenscraper: {
      devId: env.GM_SCREENSCRAPER_DEV_ID || "",
      devPassword: env.GM_SCREENSCRAPER_DEV_PASSWORD || "",
      username: env.GM_SCREENSCRAPER_USER || "",
      password: env.GM_SCREENSCRAPER_PASSWORD || "",
    },
    thegamesdb: { apiKey: env.GM_THEGAMESDB_API_KEY || "" },
    launchbox: { enabled: bool(env.GM_LAUNCHBOX, false) },
    metadataOrder: { pc: [...DEFAULT_ORDER.pc], emulated: [...DEFAULT_ORDER.emulated] },
    metadataAuto: bool(env.GM_METADATA_AUTO, true),
    anthropicApiKey: env.GM_ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY || "",
  };
}
