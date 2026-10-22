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
   (including the desktop app's `@lootden/client` dependency), commit "LootDen x.y.z".
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
  others.
- More features that other game library apps have.

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
