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
| `packages/server` | Fastify API and library scanner. `src/catalog` scans `/games`, `src/routes` is the API, `src/metadata` the IGDB/RAWG/Steam/PCGamingWiki/HowLongToBeat lookups, `src/connectors` the download tools, `src/addons` other stores' libraries |
| `packages/client` | Download, unpack, install and play logic, shared by the desktop app and the `lootden` CLI. `prepare.ts` installs and uploads installer games |
| `packages/web` | React UI. `gamepad.ts` is all controller and arrow-key navigation, `theme.ts` the themes |
| `packages/desktop` | Electron app: `main.ts` (windows, tray, IPC, start with Windows, full screen), `preload.ts` (the bridge the web UI calls) |
| `playnite/` | Playnite library extension (C#) |
| `brand/` | Logos. See [brand/README.md](brand/README.md) |
| `docs/` | `CONFIGURATION.md` (every setting) and `LIBRARY.md` (games folder layout) |

## Working on it

```sh
npm ci
npm test              # builds everything, then runs the node:test suites (about 155 tests)
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

## Recent work (richer store integrations, not released yet)

Owner's feedback on the add-ons: other stores' games had no pictures and no page, keys
seemed to need entering per device, scanning was fixed per PC, and the controller got lost.

- **Covers and pages for store games.** `src/addons/details.ts` (`StoreGameDetails`) matches
  each store game once by title against IGDB, RAWG, then the keyless Steam store (a Steam game
  straight by app id; `storeQuery` splits folder names like `FarCry6`), with SteamGridDB
  covers when that key is set. Matches are shared (`store_game_match`), details are cached a
  month (`store_game_info`). Routes in `routes/addons.ts`: `GET /api/store-games/:addon/:id`
  (the page), `.../cover` and `.../background` (302 to the image, or an uploaded file),
  `.../matches`, `.../artwork/:kind`. Games only on the PC (Ubisoft) send `?title=`.
  `StoreGame.artUrl` is the server's cover, which cards use when the store has none or its
  image is broken. The web page is `pages/StoreGame.tsx` (`/store/:addon/:id`); cards now open
  it. Ubisoft games get real names from Windows' "Uplay Install" uninstall keys.
- **Each person's own art and metadata.** Edit on a store game's page: rename it, pick a
  different match, upload or link a cover and background, or pick SteamGridDB art
  (`store_game_custom`, per person; `ArtworkPicker` in `components/ArtworkEditor.tsx` is shared
  with the admin artwork editor). Image URLs typed by a person are only ever loaded by the
  browser (the server redirects), never fetched by the server.
- **Keys once, every device.** Store accounts were already per person on the server, not
  per device; that's now said on the Game libraries card. Account settings are encrypted
  at rest (`src/auth/vault.ts`, AES-256-GCM; key from `GM_SECRET_KEY` or `<data>/secret.key`,
  created on first start). Old plain rows are encrypted at start-up. Lose the key and people
  reconnect their stores.
- **Pairing codes.** Profile, Devices and tokens, **Link another device** shows a code
  (`POST /api/auth/pair`, 8 characters, 10 minutes, once, kept hashed in memory); the new
  device's sign-in page has **Sign in with a code** (`POST /api/auth/pair/redeem`, `client:
  true` returns an API token like `/api/auth/login`). Wrong codes count toward the same
  10-per-15-minutes limit per IP.
- **Per-PC scanning.** Profile, This computer, "Games from other stores on this PC": switch
  launchers off and add folders to look in (`storeScan` in the desktop `settings.json`;
  `gm:storeScan`, `gm:addStoreFolder`; new folders only come from the folder picker).
  `packages/client/src/stores/folders.ts` recognises Steam libraries and GOG, Epic and Xbox
  game folders.
- **Controller.** Cards scrolled under the sticky filter bar are skipped and focus scrolls
  items out from under it (`reveal` in `gamepad.ts`), store grids and the Library tabs are
  zones for Y, LT/RT switch tabs, store cards are one focusable link plus their buttons, and
  B closes the screenshot lightbox.

Not done: signing in with Steam (OpenID) instead of a Steam ID, and a server-wide Steam API
key so people only need their profile link. `Integrations` (IGDB and other admin keys in
the settings table) aren't encrypted yet; the vault can do it.

## Offline mode (0.13.2)

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

## Library add-ons (released in 0.14.1)

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
- 0.13.0 also gave themes their own **Settings, Themes** tab (`components/ThemePicker.tsx`) with a small
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

## Security notes

From the October 2026 review of the server, client, web UI and desktop app. Keep this list
current when something here changes.

How it's protected:

- **Sign-in gate.** `onRequest` in `src/app.ts` requires a principal for every `/api/` route
  except health, `auth/*` and avatars. It checks the matched route pattern
  (`req.routeOptions.url`), not the raw URL, because the router decodes `%61pi` to `api`.
  Admin routes call `requireAdmin` themselves; kid profiles are filtered with `visibleGame`.
- **Passwords** are scrypt hashes; sessions and API tokens are random and stored only as
  SHA-256. Login is limited to 10 failures per IP and username per 15 minutes, counted before
  the password check so parallel guesses can't race past it. Changing a password signs out
  the person's other browser sessions (API tokens stay; they're revoked per device in Profile).
- **Single sign-on** links a login to an existing account only by its OIDC subject or by an
  email the provider doesn't mark unverified, never by username. A username that's taken
  stops the login with a message instead.
- **Paths.** Game files go through `resolveGameFile`, deletes and replaces stay inside the
  games folder, upload ids are `[A-Za-z0-9_-]{8,64}`, hosted app and BIOS names are checked
  basenames, downloaded file names go through `safeName`/`safeFolderName`. Imports skip
  symlinks inside a download. The client refuses archive and update paths outside the game
  folder.
- **Headers.** Every response has `nosniff`, `X-Frame-Options: SAMEORIGIN` and
  `strict-origin-when-cross-origin`.
- **Store accounts.** Keys and tokens are encrypted in the database (`src/auth/vault.ts`)
  and masked in every response; only `AddonRegistry` decrypts them, server side.
- **Pairing codes** are single use, expire after 10 minutes, are stored only as hashes and
  share the sign-in failure limit.
- **Desktop app.** `contextIsolation`, `sandbox`, no `nodeIntegration`. Every IPC handler
  but `gm:frame` checks the sender is the configured server (`fromServer`).

Known trade-offs (owner's call):

- The server is trusted completely by the desktop apps: it decides what gets installed and
  run, and app updates are downloaded from it without a signature check. Protect the admin
  accounts and the `GM_API_TOKEN` accordingly.
- In-browser play loads EmulatorJS from its CDN into LootDen's own origin. Set
  `GM_EMULATORJS_DATA` to a self-hosted copy to take the CDN out of the picture.
- With `GM_OIDC_AUTO_CREATE` on (the default), anyone the identity provider lets sign in
  gets an account. With Google as the provider, restrict who can sign in there or turn
  auto-create off.
- `?token=` is accepted as well as the `Authorization` header (for downloads and emulators);
  it's masked in logs.
- `npm audit` reports moderate issues only in electron-builder's dependencies (build time,
  not shipped).
