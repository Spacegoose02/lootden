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
| `LOOTDEN_SCREENSCRAPER_DEV_ID`, `LOOTDEN_SCREENSCRAPER_DEV_PASSWORD` | | Optional ScreenScraper.fr developer login (ask on the screenscraper.fr forum). Matches ROMs by checksum |
| `LOOTDEN_SCREENSCRAPER_USER`, `LOOTDEN_SCREENSCRAPER_PASSWORD` | | Optional: your own screenscraper.fr account, for a bigger daily quota |
| `LOOTDEN_THEGAMESDB_API_KEY` | | Optional TheGamesDB key (request it in the API key thread on forums.thegamesdb.net) |
| `LOOTDEN_LAUNCHBOX` | `false` | `true` downloads the LaunchBox Games Database (about 100 MB, refreshed monthly) and searches it locally. No key |
| `LOOTDEN_METADATA_AUTO` | `true` | Match new games automatically |
| `LOOTDEN_WATCH` | `true` | Watch the games folder for changes |
| `LOOTDEN_SCAN_INTERVAL_MINUTES` | `30` | Backup rescan interval; `0` turns it off |
| `LOOTDEN_EMULATORJS_DATA` | EmulatorJS CDN | Where browser emulation loads EmulatorJS from |
| `LOOTDEN_7Z_PATH` | | A 7-Zip with RAR support for imports (the image ships one) |

### Bandit (AI helper)

| Variable | Default | What it does |
| --- | --- | --- |
| `LOOTDEN_ANTHROPIC_API_KEY` (or `ANTHROPIC_API_KEY`) | | Anthropic API key for Bandit, the in-app gaming helper. A key saved in Settings, Bandit (AI helper) wins. Everything else (model, budget, limits) is set there |

### Desktop app and CLI

| Variable | What it does |
| --- | --- |
| `LOOTDEN_SERVER`, `LOOTDEN_TOKEN` | CLI: server address and token |
| `LOOTDEN_INSTALL_DIR` | CLI: where games go |
| `LOOTDEN_7Z` | CLI: path to 7-Zip |
| `LOOTDEN_CONFIG` | CLI: config file location |
| `LOOTDEN_TOOLS_DIR` | CLI: where emulators and BIOS files go |

The desktop app updates itself from the server's Get the app page, but only installs a build
whose SHA-256 matches the `SHA256SUMS` file on that version's GitHub release, so a server
can't hand PCs a file of its own. To install your own builds, or on a PC with no internet,
set `"allowUnverifiedUpdates": true` in the app's `settings.json` (in its user data folder).

## Settings in the web UI

| Section | What's there |
| --- | --- |
| **Library** | Rescan, metadata look-ups, profiles (create, kid profiles, admins) |
| **Steam & wishlist** | Your SteamID64 or profile link, **Auto-Sync Wishlist**, RSS/Atom list feeds |
| **Downloads** | Prowlarr; qBittorrent, Transmission or Deluge; SABnzbd; importing (copy or move, clean-up, downloads folder, path mappings) |
| **Wanted & rules** | Automatic searches for watched wishlist games, auto-grab, release rules (must / must not contain, preferred words, size, seeders, blocked indexers) |
| **Release sources** | Feeds of new games: on/off, address, key, request limits, extra allowed hosts, "On my network" for sources on your LAN |
| **Scanning & alerts** | ClamAV and VirusTotal; which alerts to show; an Apprise server to send them on |
| **Bandit (AI helper)** | The AI gaming helper: on/off, Anthropic API key, model (Claude Opus 5.5, Sonnet 5.5 or Haiku 5.5), thinking (quick, balanced, deep), longest answer, questions a day for grown-ups and for kids, a monthly budget in dollars that pauses him once it's reached, and this month's usage and estimated cost per person. Each person's row has the parent switch (kids start off) and their own daily limit |
| **Sign-in & services** | Public address, OIDC, IGDB / RAWG / SteamGridDB / ScreenScraper / TheGamesDB keys, LaunchBox switch, metadata source priority, itch.io and NexusMods keys |
| **News & apps** | News feeds, YouTube rows, desktop app builds for the Get the app page |

Keys and passwords entered there are stored in the database and never sent back to the
browser in full.

To use your own logos, see [brand/README.md](../brand/README.md).
