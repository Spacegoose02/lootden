import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

/**
 * Ordered schema migrations. Append only: never edit a migration that has shipped,
 * add a new one instead. user_version tracks how many have run.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE games (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL UNIQUE,
    added_at TEXT NOT NULL,
    removed_at TEXT,
    title_override TEXT,
    kid_safe_override INTEGER,
    controller_override TEXT
  );

  CREATE TABLE metadata (
    game_id TEXT PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    name TEXT NOT NULL,
    summary TEXT,
    cover_url TEXT,
    screenshots TEXT NOT NULL DEFAULT '[]',
    genres TEXT NOT NULL DEFAULT '[]',
    themes TEXT NOT NULL DEFAULT '[]',
    game_modes TEXT NOT NULL DEFAULT '[]',
    release_date TEXT,
    rating REAL,
    age_ratings TEXT NOT NULL DEFAULT '[]',
    controller_support TEXT,
    steam_app_id TEXT,
    locked INTEGER NOT NULL DEFAULT 0,
    fetched_at TEXT NOT NULL
  );

  -- Remembers failed lookups so unmatched games are not retried on every scan.
  CREATE TABLE metadata_attempts (
    game_id TEXT PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
    attempted_at TEXT NOT NULL,
    error TEXT
  );

  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    email TEXT COLLATE NOCASE,
    password_hash TEXT,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
    avatar TEXT NOT NULL,
    kid_mode INTEGER NOT NULL DEFAULT 0,
    oidc_subject TEXT UNIQUE,
    created_at TEXT NOT NULL
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    user_agent TEXT
  );

  CREATE TABLE api_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    last_used_at TEXT
  );

  CREATE TABLE user_games (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    game_id TEXT NOT NULL,
    device TEXT NOT NULL,
    installed_at TEXT,
    uninstalled_at TEXT,
    install_path TEXT,
    playtime_seconds INTEGER NOT NULL DEFAULT 0,
    last_played_at TEXT,
    PRIMARY KEY (user_id, game_id, device)
  );

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  `
  -- Downloads sent to torrent/usenet clients, so finished ones can be imported into the library.
  CREATE TABLE downloads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client TEXT NOT NULL CHECK (client IN ('qbittorrent', 'sabnzbd')),
    external_id TEXT,
    name TEXT NOT NULL,
    source_url TEXT,
    added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    added_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'downloading',
    imported_path TEXT,
    imported_at TEXT,
    error TEXT
  );
  CREATE INDEX downloads_status ON downloads(status);
  `,
  `
  -- Admin-chosen artwork: an http(s) URL, or "upload:<time>" for a file in <data>/artwork.
  ALTER TABLE games ADD COLUMN cover_override TEXT;
  ALTER TABLE games ADD COLUMN background_override TEXT;
  `,
  `
  -- Where a game keeps its saves on a player's PC ("%APPDATA%/Studio/Game" or "{game}/saves").
  ALTER TABLE games ADD COLUMN save_path TEXT;
  -- Save backups uploaded per player, so they can carry progress between devices.
  CREATE TABLE saves (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    game_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    size INTEGER NOT NULL,
    device TEXT,
    file TEXT NOT NULL
  );
  CREATE INDEX saves_user_game ON saves(user_id, game_id, created_at);
  `,
  `
  -- Downloads meant for the Emulation shelf go to Emulation/<platform>/ instead of the PC games.
  ALTER TABLE downloads ADD COLUMN platform TEXT;
  -- BIOS and firmware files admins upload once for every player's emulators.
  CREATE TABLE bios_files (
    name TEXT PRIMARY KEY,
    emulator TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha1 TEXT NOT NULL,
    uploaded_at TEXT NOT NULL
  );
  `,
  `
  -- Games found in the downloads folder and imported (or tried) from there.
  CREATE TABLE folder_imports (
    name TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    target TEXT,
    error TEXT,
    at TEXT NOT NULL
  );
  `,
  `
  -- The household wishlist: synced from Steam, filled by RSS list feeds or added by hand.
  CREATE TABLE wishlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    title_key TEXT NOT NULL UNIQUE,
    steam_app_id INTEGER,
    url TEXT,
    image TEXT,
    release_date TEXT,
    date_text TEXT,
    sources TEXT NOT NULL DEFAULT '[]',
    added_at TEXT NOT NULL,
    hidden INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE wishlist_feeds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    checked_at TEXT,
    error TEXT,
    item_count INTEGER NOT NULL DEFAULT 0
  );
  -- Dates people add to the release calendar themselves.
  CREATE TABLE calendar_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    date TEXT NOT NULL,
    note TEXT,
    url TEXT,
    created_by INTEGER,
    created_at TEXT NOT NULL
  );
  `,
  `
  -- Transmission and Deluge downloads: the client check only allowed qBittorrent and SABnzbd.
  CREATE TABLE downloads_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client TEXT NOT NULL CHECK (client IN ('qbittorrent', 'transmission', 'deluge', 'sabnzbd')),
    external_id TEXT,
    name TEXT NOT NULL,
    source_url TEXT,
    added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    added_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'downloading',
    imported_path TEXT,
    imported_at TEXT,
    error TEXT,
    platform TEXT
  );
  INSERT INTO downloads_new (id, client, external_id, name, source_url, added_by, added_at, status, imported_path, imported_at, error, platform)
    SELECT id, client, external_id, name, source_url, added_by, added_at, status, imported_path, imported_at, error, platform FROM downloads;
  DROP TABLE downloads;
  ALTER TABLE downloads_new RENAME TO downloads;
  CREATE INDEX downloads_status ON downloads(status);

  -- Wanted list: wishlist games searched for on a schedule.
  ALTER TABLE wishlist ADD COLUMN monitored INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE wishlist ADD COLUMN searched_at TEXT;
  ALTER TABLE wishlist ADD COLUMN found TEXT;
  ALTER TABLE wishlist ADD COLUMN download_id INTEGER;
  ALTER TABLE wishlist ADD COLUMN released_notified INTEGER NOT NULL DEFAULT 0;
  -- Alerts shown in the web UI (and sent through Apprise).
  CREATE TABLE notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    link TEXT,
    created_at TEXT NOT NULL,
    read_at TEXT
  );
  -- Virus scan results; flagged imports wait in .held/ until an admin decides.
  CREATE TABLE scans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    held_path TEXT,
    status TEXT NOT NULL,
    findings TEXT NOT NULL DEFAULT '[]',
    scanned_at TEXT NOT NULL
  );
  -- Newer versions found for library games.
  CREATE TABLE game_updates (
    game_id TEXT PRIMARY KEY,
    current TEXT,
    latest TEXT,
    source TEXT,
    detail TEXT,
    url TEXT,
    behind INTEGER NOT NULL DEFAULT 0,
    checked_at TEXT NOT NULL
  );
  -- Each profile's backlog status, notes and play journal per game.
  CREATE TABLE journal (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    game_id TEXT NOT NULL,
    status TEXT,
    rating INTEGER,
    notes TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, game_id)
  );
  CREATE TABLE journal_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    game_id TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
  `
  -- Releases seen in the admin's release sources (Settings, Sources).
  CREATE TABLE source_items (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    title TEXT NOT NULL,
    date TEXT,
    platform TEXT,
    url TEXT,
    image TEXT,
    summary TEXT,
    details TEXT,
    seen_at TEXT NOT NULL
  );
  CREATE INDEX source_items_source ON source_items(source, seen_at);
  `,
  `
  -- Admin corrections for update and DLC packages: what an entry is, and which game it belongs to ("none" = no game).
  ALTER TABLE games ADD COLUMN kind_override TEXT;
  ALTER TABLE games ADD COLUMN base_game_override TEXT;
  `,
  `
  -- Download Manager: games fetched from file-host links (MediaFire, Datanodes...), one row per game.
  CREATE TABLE direct_packages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    platform TEXT,
    status TEXT NOT NULL,
    error TEXT,
    imported_path TEXT,
    added_by INTEGER,
    added_at TEXT NOT NULL,
    finished_at TEXT
  );
  CREATE TABLE direct_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    package_id INTEGER NOT NULL REFERENCES direct_packages(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    url TEXT NOT NULL,
    host TEXT NOT NULL,
    file_name TEXT,
    size_bytes INTEGER,
    received_bytes INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    error TEXT
  );
  CREATE INDEX direct_files_package ON direct_files(package_id, position);
  `,
  `
  -- Download links a release source lists for a release (JSON), so Discover can fetch it directly.
  ALTER TABLE source_items ADD COLUMN downloads TEXT;
  `,
  `
  -- Library add-ons: each person's store accounts (Steam, GOG...) and the games they own there.
  CREATE TABLE addon_accounts (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    addon TEXT NOT NULL,
    config TEXT NOT NULL DEFAULT '{}',
    connected_at TEXT NOT NULL,
    last_sync_at TEXT,
    error TEXT,
    PRIMARY KEY (user_id, addon)
  );
  CREATE TABLE store_games (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    addon TEXT NOT NULL,
    external_id TEXT NOT NULL,
    title TEXT NOT NULL,
    cover_url TEXT,
    store_url TEXT,
    launch_url TEXT,
    playtime_seconds INTEGER,
    last_played_at TEXT,
    synced_at TEXT NOT NULL,
    PRIMARY KEY (user_id, addon, external_id)
  );
  `,
  `
  -- Other stores' games: which metadata entry each one matched (shared, it's public data), the
  -- details fetched for it, and each person's own changes (title, artwork, a different match).
  CREATE TABLE store_game_match (
    addon TEXT NOT NULL,
    external_id TEXT NOT NULL,
    provider TEXT,
    provider_id TEXT,
    cover_url TEXT,
    matched_at TEXT NOT NULL,
    PRIMARY KEY (addon, external_id)
  );
  CREATE TABLE store_game_info (
    provider TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    info TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (provider, provider_id)
  );
  CREATE TABLE store_game_custom (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    addon TEXT NOT NULL,
    external_id TEXT NOT NULL,
    title TEXT,
    cover TEXT,
    background TEXT,
    provider TEXT,
    provider_id TEXT,
    PRIMARY KEY (user_id, addon, external_id)
  );
  `,
  `
  -- The xREL and AnkerGames sources are gone: drop what they listed and their settings.
  DELETE FROM source_items WHERE source IN ('xrel', 'ankergames');
  UPDATE settings SET value = json_remove(value, '$.xrel', '$.ankergames') WHERE key = 'sources' AND json_valid(value);
  -- Imports now delete the download once it's in the library; switch existing installs over.
  UPDATE settings SET value = json_set(value, '$.import.mode', 'move')
    WHERE key = 'connectors' AND json_valid(value) AND json_extract(value, '$.import.mode') = 'copy';
  `,
  `
  -- Games people ask for. Approved ones go on the wanted list (wish_id).
  CREATE TABLE game_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    title_key TEXT NOT NULL,
    url TEXT,
    image TEXT,
    steam_app_id INTEGER,
    note TEXT,
    state TEXT NOT NULL DEFAULT 'pending',
    reason TEXT,
    wish_id INTEGER,
    created_at TEXT NOT NULL,
    decided_at TEXT
  );
  CREATE INDEX game_requests_user ON game_requests (user_id);
  `,
  `
  -- Steam Workshop per game: the Steam app to take items from, and the mods folder in the install.
  CREATE TABLE workshop_settings (
    game_id TEXT PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
    app_id TEXT,
    mods_path TEXT NOT NULL DEFAULT ''
  );
  `,
];

export function openDatabase(file: string): Db {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const { user_version: version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[i]!);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

export function now(): string {
  return new Date().toISOString();
}

export function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
