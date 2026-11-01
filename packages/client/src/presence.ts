import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cleanMac, storePlayId, type LocalStoreGame, type PcReport, type RunningGame } from "@lootden/shared";
import { listDrives } from "./drives.js";
import { processesIn, type RunningProcess } from "./launcher.js";

/**
 * Other stores' games running on this PC, found by their processes: anything running from
 * inside a game's install folder. Games LootDen started itself are left to `skip`.
 * `since` keeps the first time each one was seen, so the board says how long it's been on.
 */
export function runningStoreGames(
  processes: RunningProcess[],
  games: LocalStoreGame[],
  since: Map<string, string>,
  skip: Set<string> = new Set(),
  platform: NodeJS.Platform = process.platform,
  now = new Date(),
): RunningGame[] {
  const out: RunningGame[] = [];
  const found = new Set<string>();
  for (const g of games) {
    const id = storePlayId(g.addon, g.externalId);
    if (skip.has(id) || found.has(id) || !g.installDir) continue;
    // A drive root or a launcher's own folder would match everything.
    if (path.resolve(g.installDir).split(/[\\/]/).filter(Boolean).length < 2) continue;
    if (!processesIn(processes, [g.installDir], platform).length) continue;
    found.add(id);
    if (!since.has(id)) since.set(id, now.toISOString());
    out.push({ gameId: id, title: g.title, source: "store", store: g.store ?? storeName(g.addon), startedAt: since.get(id)! });
  }
  for (const id of [...since.keys()]) if (!found.has(id)) since.delete(id);
  return out;
}

const STORE_NAMES: Record<string, string> = { steam: "Steam", gog: "GOG", epic: "Epic", xbox: "Xbox", ubisoft: "Ubisoft", ea: "EA" };
const storeName = (addon: string) => STORE_NAMES[addon] ?? addon;

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

/** Where Sunshine and Moonlight install themselves. */
export function streamingPaths(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): { sunshine: string[]; moonlight: string[] } {
  if (platform === "win32") {
    const pf = [env.ProgramFiles ?? "C:\\Program Files", env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)"];
    return {
      sunshine: pf.map((p) => path.win32.join(p, "Sunshine", "sunshine.exe")),
      moonlight: [...pf.map((p) => path.win32.join(p, "Moonlight Game Streaming", "Moonlight.exe")), ...(env.LOCALAPPDATA ? [path.win32.join(env.LOCALAPPDATA, "Programs", "Moonlight Game Streaming", "Moonlight.exe")] : [])],
    };
  }
  const flatpak = (id: string) => [`/var/lib/flatpak/app/${id}`, path.join(os.homedir(), ".local/share/flatpak/app", id)];
  return {
    sunshine: ["/usr/bin/sunshine", "/usr/local/bin/sunshine", ...flatpak("dev.lizardbyte.app.Sunshine")],
    moonlight: ["/usr/bin/moonlight-qt", "/usr/bin/moonlight", "/usr/local/bin/moonlight-qt", ...flatpak("com.moonlight_stream.Moonlight")],
  };
}

/** The first of these that exists. */
export async function firstExisting(paths: string[]): Promise<string | null> {
  for (const p of paths) if (await exists(p)) return p;
  return null;
}

/** What the app tells the server about this PC: network cards for Wake-on-LAN, drives, streaming apps. */
export async function pcReport(appVersion: string, platform: NodeJS.Platform = process.platform): Promise<PcReport> {
  const macs = new Set<string>();
  const addresses = new Set<string>();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const nic of list ?? []) {
      if (nic.internal) continue;
      const mac = cleanMac(nic.mac);
      if (mac) macs.add(mac);
      if (nic.family === "IPv4") addresses.add(nic.address);
    }
  }
  const drives = await listDrives(platform).catch(() => []);
  const s = streamingPaths(platform);
  return {
    macs: [...macs],
    addresses: [...addresses],
    platform,
    appVersion,
    disks: drives.map((d) => ({ path: d.path, freeBytes: d.freeBytes, totalBytes: d.totalBytes })),
    sunshine: !!(await firstExisting(s.sunshine)),
    moonlight: !!(await firstExisting(s.moonlight)),
  };
}
