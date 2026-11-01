import "./legacy-env.js";
import "./privileges.js";
import { existsSync } from "node:fs";
import { access, constants, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { FolderWatcher } from "./catalog/watcher.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/database.js";
import { applyPendingRestore } from "./settings/backups.js";

const config = loadConfig();
// Data folders from before the rename to LootDen keep their game-manager.db.
const legacyDb = path.join(config.dataDir, "game-manager.db");
const dbFile = existsSync(legacyDb) ? legacyDb : path.join(config.dataDir, "lootden.db");
await checkWritable(config.dataDir);
// A backup chosen under Settings, Backups replaces the database before it opens.
let restored = false;
try {
  restored = applyPendingRestore(config.dataDir, dbFile);
} catch (err) {
  console.error(`The staged restore couldn't be used and was left in place: ${(err as Error).message}`);
}
const db = openDatabase(dbFile);

// The built web UI sits next to the server in the image (see Dockerfile).
const webDir = process.env.GM_WEB_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../web/dist");
// TabStationToo, for PS2 games in the browser, also sits next to the packages (see Dockerfile).
const ps2Dir = process.env.GM_PS2_EMULATOR_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../emulators/tabstationtoo");
const { app, ctx } = buildApp(config, db, { webDir, ps2Dir });

if (restored) app.log.warn("Restored the database from a backup; the one it replaced is kept as .before-restore");
// Database backups: once a day when switched on (Settings, Backups).
setTimeout(() => void ctx.backups.runDaily().catch((err) => app.log.warn(err, "Backup failed")), 5 * 60_000).unref();
setInterval(() => void ctx.backups.runDaily().catch((err) => app.log.warn(err, "Backup failed")), 3600_000).unref();

if (ctx.users.count() === 0 && config.admin.username && config.admin.password) {
  await ctx.users.create({ username: config.admin.username, password: config.admin.password, role: "admin" });
  app.log.info({ username: config.admin.username }, "Created the first admin from LOOTDEN_ADMIN_USERNAME");
}
if (ctx.users.count() === 0) app.log.warn("No accounts yet: open the web UI to create the first admin.");
if (config.oidc.issuer && !config.publicUrl) app.log.warn("GM_OIDC_ISSUER is set but GM_PUBLIC_URL is not; single sign-on stays off.");

if (config.metadataAuto) ctx.library.onScanned((games) => ctx.metadata.queueMissing(games));
await ctx.library.rescan();
app.log.info({ games: (await ctx.library.stats()).gameCount, gamesDir: config.gamesDir, metadata: ctx.metadata.status().providers }, "Library scanned");

const rescan = () => ctx.library.rescan().catch((err) => app.log.error(err, "Rescan failed"));
if (config.watch) {
  const watcher = new FolderWatcher(config.gamesDir, rescan, 15_000, (m) => app.log.warn(m));
  if (watcher.start()) app.log.info("Watching the games folder for changes");
}
if (config.scanIntervalMinutes > 0) setInterval(rescan, config.scanIntervalMinutes * 60_000).unref();
setInterval(() => ctx.auth.pruneSessions(), 6 * 3600_000).unref();
// Den Duty link: time-outs, chores first and game time from the shop, every minute.
ctx.denDuty.start();
// Import finished torrent/usenet downloads into the library.
// Steam wishlist and list feeds: every six hours, and once shortly after startup.
setTimeout(() => void ctx.wishlist.syncAll(true).catch(() => {}), 30_000).unref();
setInterval(() => void ctx.wishlist.syncAll(true).catch(() => {}), 6 * 3600_000).unref();
// The wanted list: "it's out" alerts and due Prowlarr searches every half hour.
setTimeout(() => void ctx.wanted.run().catch((err) => app.log.warn(err, "Wanted search failed")), 90_000).unref();
setInterval(() => void ctx.wanted.run().catch((err) => app.log.warn(err, "Wanted search failed")), 30 * 60_000).unref();
// Release sources switched on under Settings, Sources: every half hour.
setTimeout(() => void ctx.sources.run().catch(() => {}), 2 * 60_000).unref();
setInterval(() => void ctx.sources.run().catch(() => {}), 30 * 60_000).unref();
// Library add-ons: everyone's connected store accounts, twice a day.
setTimeout(() => void ctx.addons.syncAll().catch(() => {}), 10 * 60_000).unref();
setInterval(() => void ctx.addons.syncAll().catch(() => {}), 12 * 3600_000).unref();
// Update checks for PC games, once a day.
setTimeout(() => void ctx.versions.run().catch(() => {}), 10 * 60_000).unref();
setInterval(() => void ctx.versions.run().catch(() => {}), 24 * 3600_000).unref();
// App downloads: newer releases of the repository an admin fetched from, so desktop apps can update.
setTimeout(() => void ctx.clients.refresh().catch((err) => app.log.warn({ err: (err as Error).message }, "Checking for a new app release failed")), 5 * 60_000).unref();
setInterval(() => void ctx.clients.refresh().catch((err) => app.log.warn({ err: (err as Error).message }, "Checking for a new app release failed")), 12 * 3600_000).unref();
// Download Manager links left mid-way by a restart carry on.
ctx.direct.resumeAll();
setInterval(() => ctx.downloads.reconcile().catch((err) => app.log.warn(err, "Download import failed")), 60_000).unref();

const shutdown = async () => {
  await app.close();
  db.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await app.listen({ host: config.host, port: config.port });

/** Fails with a readable explanation instead of SQLite's "unable to open database file". */
async function checkWritable(dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
    await access(dir, constants.W_OK);
  } catch (err) {
    const uid = process.getuid?.() ?? "?";
    const gid = process.getgid?.() ?? "?";
    console.error(
      [
        `LootDen can't write to its data folder ${dir} (running as uid ${uid}, gid ${gid}).`,
        `  Reason: ${(err as Error).message}`,
        "  Fix one of these:",
        "  - Remove --user from the container's Extra Parameters. Started normally, the container makes",
        "    the data folder belong to PUID:PGID (default 99:100, Unraid's nobody:users) by itself.",
        `  - Or, on the host, give the folder mapped to /data to this user: chown -R ${uid}:${gid} <that folder>`,
      ].join("\n"),
    );
    process.exit(1);
  }
}
