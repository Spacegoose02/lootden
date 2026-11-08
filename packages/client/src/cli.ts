#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { GameServerClient } from "./api.js";
import { configPath, loadConfig, saveConfigValue } from "./config.js";
import { listDrives } from "./drives.js";
import { listInstalled, uninstallGame } from "./installed.js";
import { installGame, pickGame, type InstallEvent } from "./installer.js";
import { findSevenZip } from "./extractor.js";
import { findExecutable, launchAndTrack, saveExecutable } from "./launcher.js";
import { backupSaves, expandSavePath, restoreSaves } from "./saves.js";
import { biosFromServer, emulatorOverview, EMULATORS, installEmulator, playEmulated } from "./emulators.js";
import { configDir, envVar } from "./config.js";
import { applyUpdate, undoUpdate, updateProblem } from "./updates.js";
import { spawn } from "node:child_process";
import type { GameSummary } from "@lootden/shared";

/** Emulators, BIOS files and their saves for the command-line client. */
const toolsDir = () => envVar("TOOLS_DIR") || path.join(configDir(), "emulators");

async function needSevenZip(configured: string) {
  const s = await findSevenZip(configured);
  if (!s) throw new Error("7-Zip is needed for this; install it or set sevenZipPath");
  return s;
}

const HELP = `LootDen client

Usage:
  lootden login <username> [--server URL] Sign in and save a token for this computer
  lootden whoami                          Show who you are signed in as
  lootden list [search]                   List games on the server
  lootden info <game>                     Show a game's files
  lootden install <game> [options]        Download, unpack and remove archives
      --dest <folder>                Install under this folder (any drive), instead of installDir
      --keep-archives                Keep zip/7z/rar files after unpacking
  lootden installed                       Games installed on this computer
  lootden play <game>                     Launch an installed game and record play time
  lootden emulators                       Show emulators, versions and missing BIOS files
  lootden emulators install <id>          Download an emulator from its official releases
  lootden bios pull                       Copy the server's BIOS files into the emulators
  lootden saves <game>                    List your save backups on the server
  lootden backup <game>                   Upload this PC's saves for an installed game
  lootden restore <game> [--id N]         Restore your newest (or chosen) save backup
  lootden updates [game]                  Updates and DLC on the server, and which fit your installs
  lootden apply <update> [--force]        Apply an update or DLC to its installed game (keeps a backup)
      --force                        Apply even when the versions don't line up
  lootden undo-update <update>            Undo the most recent update applied to a game
  lootden uninstall <game>                Delete an installed game from this computer
  lootden drives                          Drives you can install to, with free space
  lootden stats                           Library size and server disk space
  lootden rescan                          Ask the server to rescan its games folder
  lootden config show | path              Show settings or where they are stored
  lootden config set <key> <value>        Keys: serverUrl, apiToken, installDir, sevenZipPath, keepArchives

<game> is an id, a title, or part of a title.
Environment overrides: LOOTDEN_SERVER, LOOTDEN_TOKEN, LOOTDEN_INSTALL_DIR, LOOTDEN_7Z, LOOTDEN_CONFIG (the older GM_ names still work).`;

function formatBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--") && a !== "--keep-archives") {
        flags[a.slice(2)] = next;
        i++;
      } else flags[a.slice(2)] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

function progressPrinter(): (e: InstallEvent) => void {
  let lastLine = 0;
  return (e) => {
    switch (e.type) {
      case "start":
        console.log(`Installing ${e.game.title} (${formatBytes(e.game.sizeBytes)}) to ${e.gameDir}`);
        break;
      case "download": {
        const now = Date.now();
        if (now - lastLine < 500 && e.received < e.total) return;
        lastLine = now;
        const pct = e.total ? ((e.received / e.total) * 100).toFixed(1) : "100";
        const line = `[${e.index + 1}/${e.count}] ${e.file}  ${pct}%  ${formatBytes(e.received)} / ${formatBytes(e.total)}`;
        if (process.stdout.isTTY) process.stdout.write(`\r${line.padEnd(100)}`);
        break;
      }
      case "downloaded":
        if (process.stdout.isTTY) process.stdout.write("\n");
        if (e.skipped) console.log(`Already downloaded: ${e.file}`);
        break;
      case "extract":
        console.log(`Unpacking ${e.archive}`);
        break;
      case "removed":
        console.log(`Removed ${e.files.length} archive file(s)`);
        break;
      case "warning":
        console.warn(`Warning: ${e.message}`);
        break;
      case "done":
        console.log(`Done: ${e.gameDir}`);
        break;
    }
  };
}

/** Reads a line from the terminal without echoing it. */
function askHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const write = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput;
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
      if (s.includes(prompt)) write.call(rl, prompt);
    };
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const { positional, flags } = parseFlags(rest);
  const config = await loadConfig();
  const api = new GameServerClient(config);

  switch (command) {
    case "login": {
      const username = positional[0];
      if (!username) throw new Error("Usage: lootden login <username> [--server http://tower:8080] [--code 123456]");
      if (typeof flags.server === "string") {
        config.serverUrl = flags.server;
        await saveConfigValue("serverUrl", flags.server);
      }
      const password = typeof flags.password === "string" ? flags.password : await askHidden("Password: ");
      const server = new GameServerClient(config);
      let session: Awaited<ReturnType<GameServerClient["login"]>>;
      try {
        session = await server.login(username, password, os.hostname(), typeof flags.code === "string" ? flags.code : undefined);
      } catch (err) {
        // Two-step sign-in: ask for the authenticator code and try once more.
        if (typeof flags.code === "string" || !/two-step/.test((err as Error).message)) throw err;
        session = await server.login(username, password, os.hostname(), await askHidden("Code from your authenticator app: "));
      }
      const { token, user } = session;
      await saveConfigValue("apiToken", token);
      console.log(`Signed in as ${user.displayName} (${user.role}). Token saved to ${configPath()}`);
      return;
    }
    case "whoami": {
      const me = await api.me();
      console.log(me.user ? `${me.user.displayName} (${me.user.username}, ${me.role}${me.user.kidMode ? ", kid profile" : ""})` : `Service token (${me.role})`);
      return;
    }
    case "list": {
      const games = await api.listGames(positional.join(" ") || undefined);
      for (const g of games) console.log(`${g.id}  ${formatBytes(g.sizeBytes).padStart(9)}  ${g.packed ? "packed" : "      "}  ${g.title}`);
      console.log(`${games.length} game(s)`);
      return;
    }
    case "info": {
      const summary = pickGame(await api.listGames(), positional.join(" "));
      const game = await api.getGame(summary.id);
      console.log(`${game.title}  [${game.id}]  ${formatBytes(game.sizeBytes)}, ${game.fileCount} file(s)`);
      for (const f of game.files) console.log(`  ${formatBytes(f.size).padStart(9)}  ${f.archive ? `[${f.archive}] ` : ""}${f.path}`);
      return;
    }
    case "install": {
      if (positional.length === 0) throw new Error("Which game? Usage: lootden install <game>");
      const summary = pickGame(await api.listGames(), positional.join(" "));
      await installGame(api, summary.id, {
        installDir: path.resolve(typeof flags.dest === "string" ? flags.dest : config.installDir),
        keepArchives: flags["keep-archives"] === true || config.keepArchives,
        sevenZipPath: config.sevenZipPath,
        onEvent: progressPrinter(),
      });
      return;
    }
    case "drives": {
      for (const d of await listDrives()) console.log(`${d.label.padEnd(16)} ${formatBytes(d.freeBytes).padStart(9)} free of ${formatBytes(d.totalBytes)}`);
      return;
    }
    case "installed": {
      const games = await listInstalled([config.installDir]);
      for (const g of games) console.log(`${g.gameId}  ${g.title}  ${g.dir}`);
      console.log(`${games.length} installed under ${config.installDir}`);
      return;
    }
    case "play": {
      const installed = await listInstalled([config.installDir, ...(typeof flags.dir === "string" ? [flags.dir] : [])]);
      const q = positional.join(" ").toLowerCase();
      const game = installed.find((g) => g.gameId === q || g.title.toLowerCase() === q) ?? installed.find((g) => g.title.toLowerCase().includes(q));
      if (!game) throw new Error(`"${positional.join(" ")}" is not installed under ${config.installDir}`);
      if (game.platform !== "pc") {
        console.log(`Starting ${game.title}`);
        const r = await playEmulated(api, game.gameId, game.dir, game.platform, { toolsDir: toolsDir(), sevenZip: await needSevenZip(config.sevenZipPath), device: os.hostname(), onEvent: (e) => console.log(e.message) });
        await api.reportActivity({ gameId: game.gameId, device: os.hostname(), event: "played", seconds: r.seconds });
        console.log(`Played for ${Math.round(r.seconds / 60)} min${r.backup ? "; saves backed up" : ""}`);
        return;
      }
      const exe = typeof flags.exe === "string" ? flags.exe : game.executable ?? (await findExecutable(game.dir, game.title));
      if (!exe) throw new Error(`No executable found in ${game.dir}; pass --exe <relative path>`);
      if (exe !== game.executable) await saveExecutable(game.dir, exe);
      console.log(`Starting ${game.title} (${exe})`);
      const seconds = await launchAndTrack(game.dir, exe);
      await api.reportActivity({ gameId: game.gameId, device: os.hostname(), event: "played", seconds });
      console.log(`Played for ${Math.round(seconds / 60)} min`);
      return;
    }
    case "emulators": {
      if (positional[0] === "install") {
        const id = positional[1] ?? "";
        const r = await installEmulator(id, { toolsDir: toolsDir(), sevenZip: await needSevenZip(config.sevenZipPath), onEvent: (e) => !e.total && console.log(e.message) });
        console.log(`Installed ${r.exe}`);
        return;
      }
      for (const e of await emulatorOverview(toolsDir())) {
        const info = EMULATORS.find((x) => x.id === e.id)!;
        const missing = info.bios.filter((b) => b.required && !e.bios.find((x) => x.id === b.id)?.present).map((b) => b.label);
        console.log(`${e.id.padEnd(12)} ${e.installed ? `v${e.installed.version}` : "not set up"}${missing.length ? `  needs: ${missing.join(", ")}` : ""}`);
      }
      console.log(`Emulators live in ${toolsDir()}`);
      return;
    }
    case "bios": {
      if (positional[0] !== "pull") throw new Error("Usage: lootden bios pull");
      const r = await biosFromServer(api, toolsDir());
      console.log(r.added.length ? `Added ${r.added.join(", ")}` : "No BIOS files to add");
      if (r.skipped.length) console.log(`Skipped (set up their emulator first): ${r.skipped.join(", ")}`);
      return;
    }
    case "saves":
    case "backup":
    case "restore": {
      const installed = await listInstalled([config.installDir]);
      const q = positional.join(" ").toLowerCase();
      const local = installed.find((g) => g.gameId === q || g.title.toLowerCase() === q) ?? installed.find((g) => g.title.toLowerCase().includes(q));
      const gameId = local?.gameId ?? pickGame(await api.listGames(), positional.join(" ")).id;
      if (command === "saves") {
        for (const b of await api.listSaves(gameId)) console.log(`${String(b.id).padStart(5)}  ${b.createdAt}  ${formatBytes(b.size).padStart(9)}  ${b.device ?? ""}`);
        return;
      }
      if (!local) throw new Error(`"${positional.join(" ")}" is not installed under ${config.installDir}`);
      const game = await api.getGame(gameId);
      if (!game.savePath) throw new Error(`No save location is set for ${game.title}; an admin can set it on the game's page`);
      const dir = await expandSavePath(game.savePath, local.dir);
      const sevenZip = await findSevenZip(config.sevenZipPath);
      if (!sevenZip) throw new Error("7-Zip is needed for save backups");
      if (command === "backup") {
        const b = await backupSaves(api, sevenZip, gameId, dir, os.hostname());
        console.log(`Uploaded ${formatBytes(b.size)} of saves from ${dir}`);
        return;
      }
      const backups = await api.listSaves(gameId);
      const chosen = typeof flags.id === "string" ? backups.find((b) => b.id === Number(flags.id)) : backups[0];
      if (!chosen) throw new Error(`No save backups for ${game.title}`);
      const { previous } = await restoreSaves(api, sevenZip, gameId, chosen.id, dir);
      console.log(`Restored the ${chosen.createdAt} backup to ${dir}${previous ? `; your old saves are in ${previous}` : ""}`);
      return;
    }
    case "updates": {
      const addons = await api.json<GameSummary[]>("/api/games?kind=addon");
      const installed = await listInstalled([config.installDir]);
      const q = positional.join(" ").toLowerCase();
      const titles = new Map((await api.listGames()).map((g) => [g.id, g.title]));
      const shown = addons.filter((a) => !q || a.title.toLowerCase().includes(q) || (a.baseGameId && titles.get(a.baseGameId)?.toLowerCase().includes(q)));
      for (const a of shown) {
        const local = installed.find((g) => g.gameId === a.baseGameId);
        const versions = a.fromVersion ? `v${a.fromVersion} -> v${a.version}` : a.version ? `v${a.version}` : "";
        const state = !a.baseGameId
          ? "update only: its game isn't on the server"
          : !local
            ? "game not installed here"
            : (updateProblem({ ...a }, local) ?? `ready to apply (installed v${local.version ?? "?"})`);
        console.log(`${a.id}  ${a.kind.padEnd(6)} ${formatBytes(a.sizeBytes).padStart(9)}  ${a.title}${versions ? `  ${versions}` : ""}\n      for ${a.baseGameId ? titles.get(a.baseGameId) : "?"}: ${state}`);
      }
      console.log(`${shown.length} update(s) and DLC`);
      return;
    }
    case "apply": {
      if (positional.length === 0) throw new Error("Which update? Usage: lootden apply <update>");
      const update = pickGame(await api.json<GameSummary[]>("/api/games?kind=addon"), positional.join(" "));
      if (!update.baseGameId) throw new Error(`${update.title}'s game isn't on the server, so there's nothing to apply it to`);
      const local = (await listInstalled([config.installDir])).find((g) => g.gameId === update.baseGameId);
      if (!local) throw new Error(`Install the game first: lootden install ${update.baseGameId}`);
      const sevenZip = await findSevenZip(config.sevenZipPath);
      const print = progressPrinter();
      const r = await applyUpdate(api, update.id, local, {
        workDir: path.join(os.tmpdir(), "lootden-updates"),
        sevenZipPath: sevenZip?.path ?? config.sevenZipPath,
        force: flags.force === true,
        onEvent: (e) => (e.type === "apply" ? console.log(e.mode === "installer" ? `Running the update's setup program for ${e.target}` : `Copying into ${e.target}`) : print(e)),
        runInstaller: (setup, target, args) =>
          new Promise((resolve, reject) => {
            console.log(`Starting ${path.basename(setup)}; point it at ${target} if it asks`);
            const child = spawn(setup, args, { cwd: path.dirname(setup), stdio: "inherit" });
            child.on("error", reject);
            child.on("close", () => resolve());
          }),
      });
      console.log(
        r.mode === "files"
          ? `Applied ${r.title}: ${r.replaced} file(s) replaced (backed up), ${r.added} added${r.version ? `; now v${r.version}` : ""}`
          : `Ran ${r.title}${r.version ? `; recorded v${r.version}` : ""}`,
      );
      return;
    }
    case "undo-update": {
      const q = positional.join(" ").toLowerCase();
      const installed = await listInstalled([config.installDir]);
      const hit = installed.flatMap((g) => (g.updates ?? []).map((u) => ({ g, u }))).find(({ u }) => u.id === q || u.title.toLowerCase() === q || u.title.toLowerCase().includes(q));
      if (!hit) throw new Error(`No applied update matches "${positional.join(" ")}"`);
      const r = await undoUpdate(hit.g, hit.u.id);
      console.log(`Undid ${r.title} on ${hit.g.title}${r.previousVersion ? `; back to v${r.previousVersion}` : ""}`);
      return;
    }
    case "uninstall": {
      const installed = await listInstalled([config.installDir]);
      const q = positional.join(" ").toLowerCase();
      const game = installed.find((g) => g.gameId === q || g.title.toLowerCase() === q);
      if (!game) throw new Error(`"${positional.join(" ")}" is not installed under ${config.installDir} (use the exact title or id)`);
      await uninstallGame(game.dir);
      await api.reportActivity({ gameId: game.gameId, device: os.hostname(), event: "uninstalled" });
      console.log(`Removed ${game.dir}`);
      return;
    }
    case "stats": {
      const s = await api.stats();
      console.log(`${s.gameCount} games, ${formatBytes(s.totalBytes)}`);
      if (s.disk) console.log(`Server disk: ${formatBytes(s.disk.freeBytes)} free of ${formatBytes(s.disk.totalBytes)}`);
      if (s.lastScanAt) console.log(`Last scan: ${s.lastScanAt} (${s.lastScanMs} ms)`);
      return;
    }
    case "rescan": {
      const s = await api.rescan();
      console.log(`Rescanned: ${s.gameCount} games`);
      return;
    }
    case "config": {
      if (positional[0] === "set" && positional.length === 3) {
        await saveConfigValue(positional[1]!, positional[2]!);
        console.log(`Saved ${positional[1]} to ${configPath()}`);
      } else if (positional[0] === "path") {
        console.log(configPath());
      } else {
        console.log(JSON.stringify({ ...config, apiToken: config.apiToken ? "********" : "" }, null, 2));
      }
      return;
    }
    default:
      console.log(HELP);
  }
}

main(process.argv.slice(2)).catch((err: Error) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
