<p align="center"><img src="brand/logo.png" width="112" alt=""></p>

# LootDen

A self-hosted library for the DRM-free PC games you own. The server runs in Docker
(I use it on Unraid), catalogues a games folder and serves a web UI. The desktop app
installs games from it on any PC in the house.

## Features

- Scans and watches a games folder, one folder or archive per game.
- Pulls covers, descriptions, genres, age ratings and controller support from IGDB, RAWG,
  Steam, PCGamingWiki and SteamGridDB. Steam and PCGamingWiki work without keys.
- Web UI with grid, cover wall and list views, filters, a release calendar, news, videos,
  a Discover page and 23 themes. Works with a gamepad.
- Desktop app for Windows and Linux: download with resume, unpack zip/7z/rar, delete the
  archives, play, track play time, uninstall. Runs in the tray and updates itself from the
  server.
- Installers and disc images: Inno Setup installers (most GOG games) are installed on the
  server while a download is imported. Others run once on a PC, then an admin can upload the
  installed folder so everyone else gets a ready-to-play download. The upload goes in 16 MB
  parts, so a reverse proxy or Cloudflare tunnel in front of the server doesn't stop it.
- Admins can delete a game from its page. The files move to `.deleted` in the games folder
  (or are removed for good), and moving them back restores the game with its settings.
- Time to beat from HowLongToBeat, with IGDB's times as the fallback.
- Updates and DLC are kept on their own page and applied over an installed game with a
  backup, so they can be undone.
- Profiles: local accounts, OIDC or forward-auth sign-in, kid profiles that only see
  kid-safe games, per-profile play time, backlog and journal.
- Save backups to the server when a game closes, restored on another PC.
- Emulation: console games in their own section. The desktop app sets up RetroArch,
  DuckStation, PCSX2, RPCS3 and xemu, and many systems also play in the browser.
- Optional download tools for admins: Prowlarr search, qBittorrent, Transmission, Deluge
  and SABnzbd, a download manager for direct file-host links, import clean-up, a wanted
  list, virus scanning and alerts (Apprise).
- `lootden` command-line client and a Playnite plugin.

## Running the server

### Docker Compose

```sh
git clone https://github.com/Spacegoose02/lootden.git
cd lootden
cp .env.example .env    # set GAMES_PATH and APPDATA_PATH
docker compose up -d    # add --build to build the image from source
```

Open `http://<server>:8080` (or whatever `HOST_PORT` is). The first visit asks you to create
the admin account, unless you set `LOOTDEN_ADMIN_USERNAME` and `LOOTDEN_ADMIN_PASSWORD`.

`.env` values used by the compose file:

| Variable | Default | |
| --- | --- | --- |
| `GAMES_PATH` | `/mnt/user/games` | Mounted at `/games` |
| `APPDATA_PATH` | `/mnt/user/appdata/lootden` | Mounted at `/data` (database, covers, saves, app builds) |
| `DOWNLOADS_PATH` | `/mnt/user/downloads` | Mounted at `/downloads`, only needed for the download tools |
| `HOST_PORT` | `8080` | Port on the host |
| `PUID`, `PGID` | `99`, `100` | User the server runs as |

### docker run

```sh
docker run -d --name lootden -p 8080:8080 \
  -v /mnt/user/appdata/lootden:/data \
  -v /mnt/user/games:/games \
  ghcr.io/spacegoose02/lootden:latest
```

### Unraid

Docker tab, Add Container:

| Field | Value |
| --- | --- |
| Repository | `ghcr.io/spacegoose02/lootden:latest` |
| Network | Bridge |
| WebUI | `http://[IP]:[PORT:8080]/` |
| Port | container `8080`, host any free port |
| Path | container `/data`, host `/mnt/user/appdata/lootden` |
| Path | container `/games`, host your PC games share |
| Path (optional) | container `/downloads`, host the share your download clients finish into |

The container starts as root, sets the owner of `/data` to `PUID:PGID` (99:100,
nobody:users) and then runs as that user. If you add `--user 99:100` under Extra
Parameters, it skips that step, so run `chown -R 99:100 /mnt/user/appdata/lootden` first.

Leave `/games` writable if you use the download tools, since imports are written there.

Compose Manager works too: copy the repo to the server, create `.env` as above and point a
stack at the folder.

### Games folder

Each entry directly inside `/games` is one game:

```
/games/
  Stardew Valley/                 a folder: everything in it is the game
  Hades.zip                       a single archive
  Celeste/setup_celeste.exe ...   an installer, set up once from the desktop app
  Updates/                        patches, shown on the Updates page
  DLC/
  Emulation/snes/Super Mario World (USA).sfc
```

If your share is split by platform (`roms/pc`, `roms/snes`), point `/games` at the PC
folder, otherwise each platform folder shows up as one game. More detail on installers,
updates, DLC and console folders is in [docs/LIBRARY.md](docs/LIBRARY.md).

### Settings

Metadata keys, sign-in, download clients, release sources and alerts are set in the web
UI under Settings. Environment variables can preset most of them; the full list is in
[docs/CONFIGURATION.md](docs/CONFIGURATION.md).

Keep it on your LAN, or put it behind a reverse proxy with HTTPS and sign-in. Don't
forward the port straight to the internet.

### Upgrading

Back up the appdata folder, then pull the new image and recreate the container
(`docker compose pull && docker compose up -d`, or Apply update on Unraid). Database
changes run on start and there is no downgrade, so keep the backup until you're happy.

Older installs from when this was called Game Manager keep working: an existing
`game-manager.db` is still used and `GM_` variables are still read (`LOOTDEN_` wins if
both are set).

## Desktop app

1. In the web UI, open **Get the app** and download the build for your system. If the page
   is empty, an admin presses **Get latest release** under Settings, News & apps (or
   uploads builds, or copies them into `<appdata>/clients`).
2. Start it, enter the server address (e.g. `http://192.168.1.10:8080`) and sign in.
3. Open a game, pick a drive and press **Install**.

| File | |
| --- | --- |
| `LootDen-Setup-<version>.exe` | Windows installer |
| `LootDen-<version>-portable.exe` | Windows, no install |
| `LootDen-<version>-linux-*.AppImage`, `.deb` | Linux |

The builds aren't code-signed, so Windows SmartScreen will warn (More info, Run anyway).
zip and 7z work out of the box; RAR needs a full 7-Zip installed (`7zz` or `p7zip-full`
on Linux). The `.deb` doesn't update itself; the other builds do.

On a handheld (ROG Ally, Steam Deck, Legion Go) the app switches to **Handheld mode**: full
screen, larger text and buttons, and it opens in front when started with the computer. Change
it under Profile, This computer. A controller moves a selection box around the app: A selects, B goes back, Y jumps between
the filters and the games, and on a menu such as Genre or Sort, A starts changing it with the
d-pad and A or B finishes; on the
ROG Ally set Armoury Crate's Control Mode to Gamepad, as Auto treats LootDen as a desktop app
and turns the controller into a mouse.

## Command-line client

Download `lootden-cli-win-x64.zip` or `lootden-cli-linux-x64.tar.gz` from Get the app.

```sh
lootden login <username> --server http://192.168.1.10:8080
lootden list zelda
lootden install "Stardew Valley" --dest D:\Games
lootden play "Stardew Valley"
lootden installed
lootden uninstall "Stardew Valley"
lootden updates
lootden help
```

`LOOTDEN_SERVER`, `LOOTDEN_TOKEN`, `LOOTDEN_INSTALL_DIR` and `LOOTDEN_7Z` override the
config file (`lootden config path` shows where it is).

## Playnite

See [playnite/README.md](playnite/README.md).

## Development

Needs Node 22.

```sh
npm install
npm test                 # builds everything and runs the tests

# server on :8080, using local folders
LOOTDEN_GAMES_DIR=./dev/games LOOTDEN_DATA_DIR=./dev/data npm run dev:server

# web UI on :5173 with hot reload, proxying /api to :8080
npm run dev:web

# desktop app
npm run build
npm start -w @lootden/desktop
npm run dist:win -w @lootden/desktop     # or dist:linux, output in packages/desktop/release

# Docker image, started the way Unraid starts it
docker build -t lootden . && sh scripts/docker-smoke.sh lootden
```

On Windows PowerShell set the variables with `$env:LOOTDEN_GAMES_DIR = "..."` first.

| Folder | |
| --- | --- |
| `packages/shared` | Types and helpers used by everything |
| `packages/server` | Fastify API, SQLite, scanner, metadata, sign-in, download tools |
| `packages/web` | React web UI, also what the desktop app shows |
| `packages/client` | Install engine and the `lootden` CLI |
| `packages/desktop` | Electron app |
| `playnite/LootDenLibrary` | Playnite plugin (C#) |
| `brand` | Replacement logos, see [brand/README.md](brand/README.md) |

New release sources go in `packages/server/src/sources/adapters/`, see
[the sources README](packages/server/src/sources/README.md).

To release, bump the version in every `package.json`, `package-lock.json` and
`packages/server/src/app.ts`, then push a `v*` tag. GitHub Actions publishes the image to
`ghcr.io/spacegoose02/lootden` and attaches the desktop apps, CLI and Playnite plugin to a
GitHub release.

## Notes

Only add games you own or have the right to use. LootDen doesn't include any game source;
the download tools only talk to indexers and clients you set up yourself.

No licence has been chosen yet, so all rights are reserved for now (see [LICENSE](LICENSE)).
