# LootDen handoff

Where the project stands and how to pick it up. The [README](README.md) covers what LootDen
does and how to run it; this file is for whoever works on it next.

## What it is

A self-hosted library for DRM-free PC games: a Docker server (deployed on Unraid) that
catalogues a games folder and serves a web UI, plus a desktop app (Windows and Linux) that
installs games from it. Owner: Spacegoose02. Repository: `Spacegoose02/lootden` (private).

## Layout

| Package | What's in it |
| --- | --- |
| `packages/shared` | Types and rules both sides use: platforms, emulators, update/DLC detection |
| `packages/server` | Fastify API and library scanner. `src/catalog` scans `/games`, `src/routes` is the API, `src/metadata` the IGDB/RAWG/Steam/PCGamingWiki/HowLongToBeat lookups, `src/connectors` the download tools |
| `packages/client` | Download, unpack, install and play logic, shared by the desktop app and the `lootden` CLI. `prepare.ts` installs and uploads installer games |
| `packages/web` | React UI. `gamepad.ts` is all controller and arrow-key navigation, `theme.ts` the themes |
| `packages/desktop` | Electron app: `main.ts` (windows, tray, IPC, start with Windows, full screen), `preload.ts` (the bridge the web UI calls) |
| `playnite/` | Playnite library extension (C#) |
| `brand/` | Logos. See [brand/README.md](brand/README.md) |
| `docs/` | `CONFIGURATION.md` (every setting) and `LIBRARY.md` (games folder layout) |

## Working on it

```sh
npm ci
npm test              # builds everything, then runs the node:test suites (about 125 tests)
npm run dev:server    # API on :8080 using GM_GAMES_DIR / GM_DATA_DIR
npm run dev:web       # UI on :5173 with hot reload
npm run build:desktop
```

Node 22 or newer. The server keeps its data in SQLite (`node:sqlite`). Tests spin the API up
in-process (`packages/server/test/helpers.ts`), so they need no network.

## Releasing

1. Bump `version` in the root `package.json` and in every `packages/*/package.json`
   (including the desktop app's `@lootden/client` dependency), `VERSION` in
   `packages/server/src/app.ts` (what `/api/health` reports), and `package-lock.json`
   (`npm install --package-lock-only`); commit "LootDen x.y.z".
2. Merge the PR to `main` once CI (`.github/workflows/ci.yml`: tests, Playnite build, Docker
   build) is green. Sessions can't merge without a review, so the owner merges.
3. Publish a GitHub release with tag `vX.Y.Z` on `main` (the owner clicks Publish; tag pushes
   from sessions have been refused). `release.yml` then builds the Windows and Linux apps,
   the CLI and the Docker image (`ghcr.io/spacegoose02/lootden`) and attaches the files a few
   minutes later.
4. On the server, Settings, News & apps, **Get latest release** pulls the new desktop builds
   so the apps update themselves.

## Branding

`brand/logo.png` (raccoon with headset) is the top bar logo, favicon, desktop and Playnite
icon. `brand/mascot.png` (raccoon in the gaming chair) is on the sign-in page and the desktop
app's connect screen. Replacing those files and rebuilding is all it takes. The older,
theme-coloured SVG raccoon is still the fallback in `packages/web/public/logo.svg`; deleting
`brand/logo.png` brings it back, along with the Profile option to recolour it.

## Recent work (0.13.2, not released yet)

Offline mode for the desktop app. Before, a PC away from the server (a handheld out of the
house, the server switched off) only got the "Connect to your LootDen server" screen, and an
open window broke as soon as requests stopped getting through.

- `packages/desktop/setup/offline.html` is a local page listing the games installed on this
  PC (from their `.lootden.json` manifests) with Play and Folder buttons, search, and
  controller and arrow-key navigation. It retries the server every 30 seconds and has
  **Try again** and **Change server**.
- `main.ts` asks `/api/health` (5 second timeout) before loading the server, so a reverse
  proxy's error page also counts as offline. `did-fail-load` on the server's pages and the
  web UI's `goOffline` bridge call (sent when `fetch` itself fails in `packages/web/src/api.ts`)
  switch to the offline page too.
- Play time from offline sessions is kept in the app's `settings.json` (`pendingPlays`) and
  sent on the next server page load. `reportActivity` now returns whether the server
  answered. Save backups are skipped offline; the next session online backs the folder up.
- Covers for the offline page are cached in `<userData>/Covers` whenever the Installed list
  is loaded online, refreshed weekly.
- The web Installed tab shows this PC's games with a note instead of an error when the
  server's list fails to load.

## Library add-ons (0.14.0, not released yet)

The More2Do list asks for add-ons for other game libraries. The foundation is in place; each
store comes as its own PR on top of it. Start with
[packages/server/src/addons/README.md](packages/server/src/addons/README.md).

- Accounts are per person (Profile, Game libraries), stored in `addon_accounts`; owned games
  in `store_games`. Synced on connect, Sync now, and every 12 hours (`index.ts`). Admins can
  switch an add-on off for everyone.
- Library, Other stores (`packages/web/src/components/StoreGames.tsx`) lists them with Play
  (the store launcher's link), Store, and In LootDen when a library game has the same title.
- The desktop app has `storeGames` (local scanners in `packages/client/src/stores/`) and
  `launchStore` (only the schemes in `STORE_LAUNCH_SCHEMES`).
- Built in so far: `steam` (Steam Web API key + Steam ID; desktop scanner reads
  `libraryfolders.vdf` and `appmanifest_*.acf`), `gog` (paste a sign-in code once; refresh
  token kept on the account; desktop finds Galaxy and Heroic installs), `epic` (same sign-in
  pattern; desktop reads the Epic launcher's manifests and Heroic) and `json-list` (any JSON
  list of games), `xbox` (OpenXBL key; played games from the title history; desktop reads the
  Xbox app's `.GamingRoot` folders), `itch` (itch.io API key) and a desktop-only Ubisoft
  Connect scanner. Games installed on the PC show under Other stores even without a
  connected account. Not done: the EA app (no reliable way found yet to read its installs
  or start them by link).

### One library (with the add-ons)

Store games are part of the library, not only their own tab (owner's pick from the "more
features" list): Home has "Recently played on your other stores", All games has a library
picker (All libraries, LootDen only, or one store) and lists store games under the LootDen
ones, Stats has per-store counts and play time, and a game page says "Also on Steam" with
Play there. Shared pieces are in `packages/web/src/components/StoreGameCard.tsx`
(`useStoreGames`, `StoreGameCard`, `launchStoreGame`).

Other ideas from that list, not started: collections and favorites, achievements, a random
pick across every library with length and never-played filters.

## Earlier releases

- 0.13.1: the home page no longer jumps when the featured game changes.
- 0.13.0: chunked uploads of installed games (`PUT /api/games/:id/prepared/parts/:upload`,
  then `.../finish`, 16 MB parts with retries; errors name the cause), controller navigation
  fixes, admins can delete games (`DELETE /api/games/:id`), new logo and mascot.
=======
## Recent work (0.13.0, not released yet)

- Uploading an installed game from the desktop app now goes in 16 MB parts with retries
  (`PUT /api/games/:id/prepared/parts/:upload`, then `.../finish`). Before, one multi-GB
  request failed behind reverse proxies and tunnels. Errors now say what to fix (proxy upload
  limit, read-only games mount, folder permissions). The old one-shot `PUT .../prepared`
  stays for older apps.
- Controller navigation: selects no longer trap the d-pad, the filter bar and the games
  remember where you left them, Y switches between them.
- Admins can delete games (`DELETE /api/games/:id`, `?permanent=true` to remove the files).
- New logo and mascot.

- Themes have their own **Settings, Themes** tab (`components/ThemePicker.tsx`) with a small
  mock of the app in each theme's colours and a Dark/Light filter. Ten new themes (Rosé Pine,
  Kanagawa, Evergreen, Aurora, Tropical Sunset, Latte, Sakura, Paper, Red Visor, Famicom), 33
  in all. Everyone gets Settings in the menu now, but non-admins only see the Themes tab.
  Profile shows the current theme with a link there. The choice is still `gm-theme` in
  localStorage. Theme colours must stay `#hex`: the desktop title bar buttons only accept hex.

The original upload error was only visible as a tiny screenshot, so the exact cause wasn't
confirmed. If uploads still fail, the error text now names the cause; start there.

## Already done from the backlog

- HowLongToBeat times (0.12.0), with IGDB as the fallback; can be turned off in Settings.
- Handheld mode for the ROG Ally, Steam Deck and Legion Go (0.12.0): full screen, bigger
  controls, opens in front at start-up. 0.12.3 added a reliable Start with Windows, a
  "LootDen (full screen)" shortcut and `--fullscreen` for Steam. Windows' Xbox full screen
  experience only lets the device maker choose the home app, so starting LootDen with
  Windows is as close as it gets.

## Next up (the owner's More2Do list)

- An add-on system for other game libraries, then add-ons for Steam, GOG, Epic, Xbox and
  others (one PR each after the foundation).
- More features that other game library apps have.
- Offline mode is done in 0.13.2.

## Things to know

- The container runs as `99:100` on Unraid. `/games` must be writable for downloads,
  uploads, `.replaced` and `.deleted`.
- Entries starting with `.` in the games folder are ignored by the scanner, which is why
  uploads in progress, `.replaced` and `.deleted` don't show up as games.
- A game's id is a hash of its path in the games folder, so renaming a folder makes it a new
  game; `replaceGame` in `src/catalog/library.ts` carries settings over when the app does it.
