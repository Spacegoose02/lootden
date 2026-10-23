# Configuration

Most settings live in the web UI under **Settings** (admins only). Environment variables
cover what's needed before the UI exists and can preset the rest. If both are set, the
Settings page wins.

Old `GM_` names still work; `LOOTDEN_` wins if both are set. [.env.example](../.env.example)
is a commented copy for Docker Compose.

## Environment variables

### Paths and server

| Variable | Default | What it does |
| --- | --- | --- |
| `LOOTDEN_GAMES_DIR` | `/games` | The games folder |
| `LOOTDEN_DATA_DIR` | `/data` | Database, cover cache, save backups, app downloads |
| `LOOTDEN_PORT` | `8080` | Port the server listens on inside the container |
| `LOOTDEN_HOST` | `0.0.0.0` | Address the server listens on |
| `LOOTDEN_PUBLIC_URL` | | The address people use, e.g. `https://games.example.com`. Needed for OIDC and secure cookies |
| `LOOTDEN_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |
| `PUID`, `PGID` | `99`, `100` | The user the server runs as when the container starts as root (Unraid's nobody:users) |

### First admin and tokens

| Variable | What it does |
| --- | --- |
| `LOOTDEN_ADMIN_USERNAME`, `LOOTDEN_ADMIN_PASSWORD` | Creates this admin at first start; ignored once any account exists. Without them, the first visit asks you to create one |
| `LOOTDEN_API_TOKEN` | Optional admin token for scripts (`openssl rand -hex 32`). Empty disables it |
| `LOOTDEN_SECRET_KEY` | Encrypts store accounts' API keys and sign-in tokens in the database. Empty: a random key is created in `<data>/secret.key` on first start; back that file up with the database |

### Sign-in

| Variable | What it does |
| --- | --- |
| `LOOTDEN_OIDC_ISSUER`, `LOOTDEN_OIDC_CLIENT_ID`, `LOOTDEN_OIDC_CLIENT_SECRET` | Sign in with TinyAuth, Authelia, Authentik or any OIDC provider |
| `LOOTDEN_OIDC_NAME` | Button label (default "Single sign-on") |
| `LOOTDEN_OIDC_SCOPES` | Default `openid profile email groups` |
| `LOOTDEN_OIDC_ADMIN_GROUP` | Members of this group become admins |
| `LOOTDEN_OIDC_AUTO_CREATE` | Create a profile on first sign-in (default `true`) |
| `LOOTDEN_AUTH_HEADER_USER` | Trust a forward-auth header, e.g. `remote-user` |
| `LOOTDEN_AUTH_HEADER_EMAIL`, `_NAME`, `_GROUPS` | Other forward-auth headers (defaults `remote-email`, `remote-name`, `remote-groups`) |
| `LOOTDEN_TRUSTED_PROXIES` | Comma-separated addresses or ranges allowed to send those headers. Required for header sign-in |
| `LOOTDEN_AUTH_HEADER_ADMIN_GROUP` | Group in the groups header that makes someone admin |

### Metadata and library

| Variable | Default | What it does |
| --- | --- | --- |
| `LOOTDEN_IGDB_CLIENT_ID`, `LOOTDEN_IGDB_CLIENT_SECRET` | | Twitch app keys for IGDB (free at dev.twitch.tv). Without them, Steam and PCGamingWiki are used |
| `LOOTDEN_RAWG_API_KEY` | | Optional RAWG metadata (free at rawg.io/apidocs) |
| `LOOTDEN_STEAMGRIDDB_API_KEY` | | Optional covers and backgrounds (free at steamgriddb.com) |
| `LOOTDEN_METADATA_AUTO` | `true` | Match new games automatically |
| `LOOTDEN_WATCH` | `true` | Watch the games folder for changes |
| `LOOTDEN_SCAN_INTERVAL_MINUTES` | `30` | Backup rescan interval; `0` turns it off |
| `LOOTDEN_EMULATORJS_DATA` | EmulatorJS CDN | Where browser emulation loads EmulatorJS from |
| `LOOTDEN_7Z_PATH` | | A 7-Zip with RAR support for imports (the image ships one) |

### Desktop app and CLI

| Variable | What it does |
| --- | --- |
| `LOOTDEN_SERVER`, `LOOTDEN_TOKEN` | CLI: server address and token |
| `LOOTDEN_INSTALL_DIR` | CLI: where games go |
| `LOOTDEN_7Z` | CLI: path to 7-Zip |
| `LOOTDEN_CONFIG` | CLI: config file location |
| `LOOTDEN_TOOLS_DIR` | CLI: where emulators and BIOS files go |

## Settings in the web UI

| Section | What's there |
| --- | --- |
| **Library** | Rescan, metadata look-ups, profiles (create, kid profiles, admins) |
| **Steam & wishlist** | Your SteamID64 or profile link, **Auto-Sync Wishlist**, RSS/Atom list feeds |
| **Downloads** | Prowlarr; qBittorrent, Transmission or Deluge; SABnzbd; importing (copy or move, clean-up, downloads folder, path mappings) |
| **Wanted & rules** | Automatic searches for watched wishlist games, auto-grab, release rules (must / must not contain, preferred words, size, seeders, blocked indexers) |
| **Release sources** | Feeds of new games: on/off, address, key, request limits, extra allowed hosts, "On my network" for sources on your LAN |
| **Scanning & alerts** | ClamAV and VirusTotal; which alerts to show; an Apprise server to send them on |
| **Sign-in & services** | Public address, OIDC, IGDB / RAWG / SteamGridDB keys, itch.io and NexusMods keys |
| **News & apps** | News feeds, YouTube rows, desktop app builds for the Get the app page |

Keys and passwords entered there are stored in the database and never sent back to the
browser in full.

To use your own logos, see [brand/README.md](../brand/README.md).
