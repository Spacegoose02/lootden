# Library add-ons

A library add-on brings in the games someone owns on another store (Steam, GOG, Epic, Xbox...)
so they show up in LootDen next to the server's own games. Each person connects their own
accounts under **Profile, Game libraries**; their games appear under **Library, Other stores**
with Play (through the store's launcher), Store and, when the server has the same game,
In LootDen. Admins can switch an add-on off for everyone from the same card.

## How it fits together

| Part | Where | What it does |
| --- | --- | --- |
| Server add-on | `packages/server/src/addons/<id>.ts` | Lists the games an account owns (`games()`), from the fields the person filled in |
| Registry | `registry.ts` | Stores accounts (`addon_accounts`) and games (`store_games`) per person, syncs on connect, on Sync now and every 12 hours, matches titles to the library |
| Routes | `../routes/addons.ts` | `GET /api/addons`, `PUT/DELETE /api/addons/:id/account`, `POST /api/addons/:id/sync`, `PUT /api/addons/:id` (admin on/off), `GET /api/store-games` |
| Desktop scanner (optional) | `packages/client/src/stores/` | Finds which of the store's games are installed on the PC, so they get a ▶ Play and the "Installed on this PC" filter |
| Launch links | `STORE_LAUNCH_SCHEMES` in `packages/shared/src/addons.ts` | The desktop app only opens these schemes from a Play button |

## Built in

| Add-on | What it reads |
| --- | --- |
| `steam` | Owned games and play time from the Steam Web API (Steam ID + API key); the desktop app reads Steam's library folders for installed games (`packages/client/src/stores/steam.ts`) |
| `gog` | Owned games through GOG's sign-in (the Galaxy client's public credentials, as Heroic and Playnite use). The person pastes the code once; the refresh token is kept with `ctx.save()`. Desktop: Galaxy's registry keys on Windows, Heroic's `gog_store/installed.json` |
| `json-list` | A JSON list of games at any address; for stores without an add-on, and the template for new ones |

## Adding one

1. Copy `json-list.ts` to `my-store.ts`. Set `id`, `name` (the store's name, shown on badges),
   `description`, `homepage` (where people get the key you ask for) and `fields`. Mark API keys
   and tokens `secret: true`: they're never sent back to the browser.
2. Write `games(ctx)`. `ctx.config` has what the person entered, by field key. Fetch only
   through `ctx.fetch`: it times out after 30 seconds and keeps profiles that aren't admins off
   the server's own network, redirects included. Throw an `Error` with a message the person
   can act on ("Wrong API key", "Make your game details public"); it's shown on their card.
   Store what you need next time (a refreshed token) with `ctx.save({ key: value })`; keys
   that aren't fields stay on the server. A field with `oneTime: true` (a sign-in code) is
   never shown again, and `link` puts a link (a store's sign-in page) under it.
3. Return each game's store id as `externalId` (it must stay the same between syncs), the
   title, and when you have them `coverUrl`, `storeUrl`, `launchUrl`, `playtimeSeconds` and
   `lastPlayedAt`. Or give the add-on a `launchUrl(externalId)` instead of setting it per game.
4. If the launcher's link scheme isn't in `STORE_LAUNCH_SCHEMES`, add it.
5. List the add-on in `index.ts`, add a test in `packages/server/test/addons.test.ts` with a
   fake `fetchImpl`, and rebuild.
6. Optional: a desktop scanner in `packages/client/src/stores/<id>.ts` implementing
   `StoreScanner` (same `addon` id, `externalId`s matching the server's), listed in
   `STORE_SCANNERS`.
