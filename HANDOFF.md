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
npm test              # builds everything, then runs the node:test suites (about 157 tests)
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
   build) is green. Sessions can merge when the owner asks for it; otherwise the owner merges.
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

## Richer store integrations (0.15.0)

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

Since then: **Sign in with Steam** (`src/addons/steam-signin.ts`, Steam's OpenID 2.0, checked
with Steam's `check_authentication`) fills in the Steam ID. The callback
(`/api/addons/steam/signin/callback`, public) finds the person by a one-time state value, as
the desktop app finishes it in the system browser; the profile page polls until the account
shows up. And a **server-wide Steam Web API key**: fields marked `shared` (Steam's `apiKey`)
can be set once by an admin on the add-on's card (`PUT /api/addons/:id/shared`, encrypted
like accounts, never sent back); a person's own value wins. `Integrations` (IGDB and other admin keys in the settings table) aren't encrypted yet; the
vault can do it.

## Version pills on more covers (0.21.2)

- `versionFromName` reads `Build 12345`, `(1.0.3)` / `[1.2]` and bare 2+ dot versions; title
  numbers are left alone. `versionFromFiles` looks inside PC game folders (GOG installers, a
  single subfolder, top-level installers/archives) when the name has none.
- Admins can set a version on the game page (`games.version_override`); blank resets it.
- Existing games pick up the new versions on the next library scan.

## Release files fix (0.21.1)

- v0.20.0, v0.20.1 and v0.21.0 were published without files: in `release.yml` the plain
  YAML `run:` for SHA256SUMS had `  #` inside the sed, which YAML read as a comment, so the
  step failed. It is a `run: |` block now. 0.21.1 is 0.21.0 plus that fix.

## Bandit, the AI gaming helper (0.21.0)

A chat in the corner of every page (X on a controller) that helps with the game on screen.
Shared rules and types are in `packages/shared/src/helper.ts`; the server side is
`src/helper/service.ts` (`HelperService`) and `routes/helper.ts`; tests in
`server/test/helper.test.ts`.

- **Provider**: Anthropic through `@anthropic-ai/sdk` (`anthropicAi`), streaming, with server-side
  refusal fallbacks (`fallbacks: "default"`) and prompt caching. Tests pass `helperAi` to
  `buildApp` so nothing reaches the real API. The key is saved encrypted with the vault, or comes
  from `LOOTDEN_ANTHROPIC_API_KEY` / `ANTHROPIC_API_KEY`.
- **Costs**: admins pick the model, thinking effort and longest answer (`max_tokens`), daily
  question limits for grown-ups and kids (and per person), and a monthly dollar budget. Every
  answer's tokens are priced with `helperCost` (list prices in `HELPER_MODELS`) and added to
  `helper_usage` per person per day; once the month's total reaches the budget Bandit pauses
  until the 1st. Days and months follow the household time zone. A question whose answer
  fails doesn't count.
- **Who gets him**: `helper_access.allowed` is the parent switch (NULL: on for grown-ups, off for
  kids), `enabled` the person's own switch in Profile. Kid profiles get extra kid-safe
  instructions, and games they can't open aren't passed to the AI.
- **Game context**: `GameDetail` and `StoreGame` call `useHelperGame`, so the chat knows the
  title, platform, genres and summary. One chat per game, kept while the app is open; the
  browser sends the chat back each time (last 20 turns).
- **Controller**: X (`HELPER_EVENT` in `gamepad.ts`) opens and closes him. The panel is a
  `role="dialog"`, so the d-pad stays inside and B closes it; with a pad the first suggested
  question is focused, so nobody has to type.

## Bug check fixes, Back keeps your place (0.20.1)

- **Play time**: bedtime hard stop closes the game; offline sessions are credited to the
  profile that played; store launches, `/api/games/:id/play` and the browser player respect
  limits; launcher games stay timed while any process from the game's folder runs; a broken
  token falls back to the last known allowance instead of lifting limits.
- **Pop-ups and saves**: B / Esc closes roulette, celebrations and player cards
  (`useEscape`); only celebrations actually shown are marked seen; save slots work offline.
- **Back keeps your place**: `useScrollMemory` in Layout restores scroll and the focused game
  on Back; new pages start at the top.

## Family fun pack (0.20.0)

Shared rules live in `packages/shared/src/family.ts`; the server side is `users/family.ts`
(`FamilyService`), `users/shelves.ts` and `routes/family.ts`; tests in `server/test/family.test.ts`
and `client/test/family.test.ts`.

- **Play sessions** (`play_sessions`): every "played" report is also a dated session (the app
  sends `endedAt`, so offline play lands on the right day). Days, weeks and bedtimes follow the
  household time zone (Settings, Library, Family; blank uses the server's `TZ`).
- **Play time limits and bedtime** per profile (`play_limits`, Settings, Profiles, Play time).
  `GET /api/me/allowance` is today's state. The desktop app checks it before starting a game,
  keeps the last answer for offline (`keptAllowance`), and `watchPlayTime` (client
  `playtime.ts`) gives heads-ups at 10, 5 and 1 minute, then time's up; with "close the game"
  on, `launchAndTrack`'s stop signal closes it a minute later (`taskkill /T` on Windows).
  Emulated games only get heads-ups. Store games launched through Steam etc. aren't counted.
- **Bonus time** (`time_requests`): kids ask on Requests or Profile, admins answer on Requests
  (yes, half, no) or give time from the Play time editor.
- **Profile tokens in the app**: `client()` in `desktop/src/main.ts` now keeps one device token
  per profile (`profileTokens`), picked by who is signed in to the window, so play time, limits
  and saves follow the person instead of whoever signed in first on that PC.
- **Save slots** (client `saveslots.ts`, household setting, on by default): before a game with
  a save location starts, the last player's save folder moves to
  `<userData>/SaveSlots/<game>/<profile>` and this player's comes back (or their newest server
  backup). Nothing is deleted; a replaced slot is kept as `.old`.
- **Achievements, XP and levels**: `ACHIEVEMENTS` in shared, worked out from stats on
  `GET /api/me/progress` and recorded in `achievements`. Levels unlock raccoon parts:
  built avatars are seeds like `b-<fur>-<palette>-<eyes>-<mouth>-<gear>`; random seeds still
  only use the starter parts, so existing avatars look the same. `PATCH /api/me` refuses
  locked parts.
- **Celebrations** (`GET /api/me/celebrations`, `FunLayer.tsx`): new badges, bonus time and
  requested games that arrived ("Wish granted"). Requests from before this are marked
  `legacy` and settled quietly on first look.
- **Weekly recap** (`GET /api/family/recap`, Library, Family, and a strip on Home): leaderboard,
  top game, busiest day, and a shareable PNG drawn on a canvas. Kids see "A grown-up game"
  instead of titles they couldn't open.
- **Game of the day and roulette** (`Roulette.tsx`): a daily pick per person on Home, and a
  slot-machine reel with filters. Spins count toward a badge (`POST /api/me/roulette`).
- **Play together tags**: `GameSummary.together` from IGDB game modes and genres, or an admin's
  pick on the game page (`games.together_override`). Library filter, Home row.
- **Shelves** (`shelves`, `shelf_games`): personal or household (admins), shown in Library,
  Shelves and as Home rows; "Add to shelf" on game pages.

## Bugs board fixes (0.19.0)

- **Installers inside archives**: `catalog/peek.ts` lists a zip/rar/7z's entries with 7-Zip
  (`l -slt -ba -p`, no password prompt, 60 s timeout) and runs `setupKindOf` on them, so
  "Install here and upload" shows before anything is unpacked. Packed PC games are checked
  in the background after each scan (3 at a time) and cached in `archive_peeks` (path, size,
  date).
- **Versions on covers**: `GameSummary.latestVersion`; `VersionTag` on cards, cover wall tiles
  and list rows (green when up to date, amber `old → new` when an update is waiting).
- **Format filter**: Library `?format=` (installers and disc images, ready folders, archives).

## Every launcher in Library, requests, Workshop, Console home (0.18.0)

- **Library tabs**: Installed (default in the app), All, Backlog, Stats. Other stores is gone;
  its games are in All under the source filter "Every other store" (`?tab=stores` redirects).
  Installed lists LootDen and store installs together with launcher filter chips.
- **Metadata refresh**: per game (`POST /api/games/:id/metadata/refresh`), per store game, and
  in bulk by scope (`POST /api/metadata/refresh {scope: all|pc|emulated|<platform>}`), so a
  changed source priority reaches games already matched.
- **Controller**: popups keep the d-pad inside them, focus resumes near where it was, the
  left stick follows its strongest axis, `<summary>` is focusable, the lightbox has buttons.
  Offline page: store games, auto-retry, pad repeat.
- **Game requests** (`/requests`, `RequestService`, `game_requests` table): anyone asks,
  admins approve onto the wanted list (searching when Prowlarr is set up) or decline; status
  runs pending, searching, downloading, ready. Alert kind `requests`.
- **Steam Workshop** (`workshop_settings` table, `routes/workshop.ts`): admins set the app id
  and a mods folder per game; items by pasted link (no key) or browse/search with the Steam
  add-on's Web API key. The desktop app downloads with SteamCMD (fetched from Valve, anonymous
  login; the Alpine server image can't run it) into `<game>/<mods>/<item id>` with a
  `.lootden-workshop.json` marker; Remove only touches marked folders.
- **Console home**: `/api/home` `resume` (last played PC game) leads Home with a big Play;
  Ready to play mixes LootDen and store installs; pill menu, clock in the app, controller
  button hints along the bottom while a pad is in use.

## Other stores bugs (0.18.1)

- **Requests from Discover, Wishlist and Calendar**: `RequestButton` (`pages/Requests.tsx`) is on
  Discover cards, wishlist cards and calendar rows for everyone but admins, and knows what the
  person already asked for. Kid profiles now get Discover, Wishlist and Calendar (read-only:
  no adding dates or wishlist games, no YouTube rows); a Discover page whose ratings say it
  isn't for kids is a 403 for them.
- **Workshop on Steam store games**: `/api/store-games/steam/:appId/workshop(/items)`; the
  store game page reuses `WorkshopPanel` with `steamAppId`, and Subscribe opens the item in
  Steam (`steam://url/CommunityFilePage/<id>`), which downloads it.
- **Browser rules per person** (`browser_policy` table, `shared/src/browser.ts`): kid-safe
  (only `KID_SITES` plus the admin's extras, Kiddle search, safe search forced, no launchers,
  its own `persist:lootden-browser-kids` sign-ins) or open, plus a blocked list either way.
  Kid profiles default to kid-safe. Admins set it in Settings, Profiles, Browser
  (`/api/users/:id/browser`); the app asks `/api/me/browser` each time the browser opens,
  keeps the last answer for offline, and checks every page and frame in `onBeforeRequest`.
  Blocked pages show `setup/blocked.html`.
- **Store covers offline**: the app keeps each store game's cover from the server
  (`Covers/store-<addon>-<id>.*`, weekly, when the library's store games are scanned) and
  falls back to Steam's own `appcache/librarycache` art (`steamLibraryCover`).

## Glow themes, feed names, Home posters (0.17.0)

- **Glow theme group** (50 themes in all): Laser Grid in six colours, Nuclear plus Cherenkov,
  Meltdown, Radium and Isotope, and six Neon themes. `ThemeDef.family` (`laser` | `nuclear` |
  `neon`) sets `data-family` on `<html>`, and the extras in `styles.css` are keyed on it. Only
  headings and the main button glow; text stays at 4.5:1 contrast. Laser Grid and Nuclear kept
  their ids, so saved choices still work.
- **Custom names for RSS/Atom and JSON feed sources** (Settings), used on Discover, in wishlist
  alerts and in source errors; blank falls back to the default name.
- **Home Installed row posters**: games no other row carries are looked up directly instead of
  showing a coverless stub, and art that's nearly the card's shape fills the card.

## Controller navigation (0.16.2)

- **D-pad up goes row by row** instead of jumping past rows (`gamepad.ts`).
- **LB/RB switch the top menu sections** (`components/Layout.tsx`).

## Store and offline fixes (0.16.1)

- **Install or Play on store games.** In the desktop app, once this PC's launchers have been
  scanned (`useStoreGames().scanned`), a store game that isn't installed says **Install**
  (`storeInstallUrl`: `steam://install/<id>`, Epic's `?action=install`, the others open the game
  in their launcher); installed ones say ▶ Play. A browser can't tell, so it keeps Play.
- **Filter bars no longer float** over the games when scrolling (`.filters` isn't sticky).
- **Games removed from the server still play.** The desktop app keeps each installed game's
  details from the server in `<userData>/GameInfo/<id>.json` (weekly, and right after an
  install; a 404 keeps the last copy). When `/api/games/:id` fails and the game is installed
  here, the game page shows `components/LocalGame.tsx` (`gm:localGame`: the manifest, cached
  details and cover) with Play, Run installer, Open folder and Uninstall, a "removed from the
  server" notice, and a link to the new version when the server has a game with the same
  title or file. Save backups and the uninstall report skip quietly for such games.
- **EA app games** are found on Windows (see the add-ons README).

## Also in 0.16.0

- **Laser Grid and Nuclear themes** (35 themes at the time).
- **xREL and AnkerGames sources removed**; downloads are deleted once imported by default.
- **Retro metadata sources**: ScreenScraper, TheGamesDB and LaunchBox for console games, with
  an admin-set source priority (see `docs/CONFIGURATION.md`).

## Handheld polish (0.16.0)

- Home puts an **Installed** row straight under Featured: `/api/home` sends an `installed`
  section (this person's installs on any device, up to 100); the desktop app narrows it to the
  games on that PC (`desktop.installed()`, with `stub()` from `InstalledGames.tsx` for games the
  server doesn't list).
- **Poster and cover size** (Profile, Appearance; `gm-poster` in localStorage, `data-poster` on
  `<html>`): Small, Normal (default), Large (the old size) or Hide banner. It sizes the Featured
  poster, a game page's poster and the covers in rows and grids. Normal caps the poster at about a
  third of the screen's height, less in touch or handheld mode.
- HUD-style styling at the end of `styles.css` (row title ticks, banner corner brackets and scan
  line, focus glow), all from theme colours.
- The offline page wears the app's theme: the web UI sends its colours with `offlineTheme`
  (`gm:offlineTheme`, kept as `offlineTheme` in the desktop `settings.json`, #hex only), and
  the page shows the selected game big with its cover blurred behind, an Offline badge, a
  clock and controller hints in handheld mode.

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
  connected account. The EA app is desktop-only too (`stores/ea.ts`, see the add-ons README).

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

## Built-in web browser

For handhelds and the Xbox full screen experience, where opening Edge means leaving the
controller behind. `packages/desktop/src/browser.ts` (`WebBrowser`) opens a window of its own
over LootDen, which hides meanwhile so its controller navigation doesn't act on the same
presses. The toolbar and start page are the local `setup/browser.html` (preload
`browser-preload.ts`, IPC `gm:browser:*` accepted only from that page). Each tab is a
`WebContentsView` in the `persist:lootden-browser` session: sandboxed, no preload, apart from
the server's cookies. Only http(s) pages open; store launcher links (`isStoreLaunchUrl`) ask
first; camera and microphone ask once per site per run. Address bar, bookmark and launcher
rules are in `packages/client/src/browser.ts` (tested). The controller has three modes:
toolbar, a pointer on the page (left stick, A clicks, right stick scrolls), and pass-through
for cloud gaming (Menu; View + Menu comes back). Opened from the Browser menu item (desktop app,
not kids), the tray, the "Web browser" jump list task (`--browser`), and, in handheld mode or when
chosen in Profile, links from LootDen's pages.
