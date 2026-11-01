import { spawn } from "node:child_process";
import https from "node:https";
import { firstExisting, streamingPaths } from "./presence.js";

/**
 * Game streaming with Sunshine (on the PC that runs the games) and Moonlight (on the TV PC,
 * laptop or tablet that shows them). LootDen adds its installed games to Sunshine as apps that
 * start through LootDen (so play time limits and Now Playing still work), and starts Moonlight
 * on a game from the game's page. Pairing Moonlight with Sunshine is done once, in Moonlight.
 */

export interface SunshineApp {
  name: string;
  cmd?: string;
}

/** The Sunshine app for a LootDen game: started through the LootDen app's play link. */
export function sunshineAppFor(game: { gameId: string; title: string }, appPath: string): Record<string, unknown> {
  return {
    name: game.title,
    output: "",
    cmd: `"${appPath}" "lootden://play/${game.gameId}"`,
    "working-dir": "",
    "image-path": "",
    detached: [],
    "prep-cmd": [],
    // LootDen hands the game over and exits: keep streaming while the game runs.
    "auto-detach": "true",
    "wait-all": "true",
    "exit-timeout": 5,
    index: -1,
  };
}

/** Which installed games aren't Sunshine apps yet (matched by name). */
export function missingSunshineApps<T extends { title: string }>(games: T[], apps: SunshineApp[]): T[] {
  const have = new Set(apps.map((a) => a.name.trim().toLowerCase()));
  return games.filter((g) => !have.has(g.title.trim().toLowerCase()));
}

/** Calls Sunshine's web API on this PC (self-signed certificate, so only ever localhost). */
export function sunshineApi<T>(method: "GET" | "POST", path: string, auth: { user: string; pass: string }, body?: unknown, port = 47990): Promise<T> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = https.request(
      {
        host: "localhost",
        port,
        path,
        method,
        rejectUnauthorized: false,
        timeout: 8000,
        headers: {
          authorization: `Basic ${Buffer.from(`${auth.user}:${auth.pass}`).toString("base64")}`,
          ...(data ? { "content-type": "application/json", "content-length": String(data.length) } : {}),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (c: Buffer) => (text += c.toString()));
        res.on("end", () => {
          if (res.statusCode === 401) return reject(new Error("Sunshine refused the username or password (the ones for its web page, https://localhost:47990)"));
          if (!res.statusCode || res.statusCode >= 400) return reject(new Error(`Sunshine answered ${res.statusCode}`));
          try {
            resolve((text ? JSON.parse(text) : {}) as T);
          } catch {
            reject(new Error("Sunshine sent something LootDen can't read; update Sunshine"));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("Sunshine didn't answer. Is it running?")));
    req.on("error", (err) => reject((err as NodeJS.ErrnoException).code === "ECONNREFUSED" ? new Error("Sunshine isn't running on this PC") : err));
    if (data) req.write(data);
    req.end();
  });
}

/** Adds the games that aren't there yet; returns their titles. */
export async function syncSunshine(games: Array<{ gameId: string; title: string }>, appPath: string, auth: { user: string; pass: string }): Promise<string[]> {
  const list = await sunshineApi<{ apps?: SunshineApp[] }>("GET", "/api/apps", auth);
  const missing = missingSunshineApps(games, list.apps ?? []);
  for (const g of missing) await sunshineApi("POST", "/api/apps", auth, sunshineAppFor(g, appPath));
  return missing.map((g) => g.title);
}

/** The command that starts Moonlight streaming one app from a host. */
export function moonlightCommand(moonlight: string, host: string, appName: string): { cmd: string; args: string[] } {
  const flatpak = /flatpak\/app\/com\.moonlight_stream\.Moonlight/.exec(moonlight);
  return flatpak ? { cmd: "flatpak", args: ["run", "com.moonlight_stream.Moonlight", "stream", host, appName] } : { cmd: moonlight, args: ["stream", host, appName] };
}

/** Starts Moonlight on a game from another PC. */
export async function streamWithMoonlight(host: string, appName: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  const moonlight = await firstExisting(streamingPaths(platform).moonlight);
  if (!moonlight) throw new Error("Install Moonlight on this PC first (moonlight-stream.org), and pair it with the gaming PC once");
  if (!/^[\w.:-]+$/.test(host)) throw new Error("That isn't a PC address");
  const { cmd, args } = moonlightCommand(moonlight, host, appName);
  spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: false }).unref();
}
