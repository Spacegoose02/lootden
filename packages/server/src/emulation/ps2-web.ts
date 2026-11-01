import { existsSync } from "node:fs";
import path from "node:path";
import { EMULATORS, type GameDetail, type ServerBiosFile } from "@lootden/shared";
import { json, type Db } from "../db/database.js";
import { browserPlayable } from "./browser-play.js";

/**
 * PS2 games in the browser, through TabStationToo (PCSX2 compiled to WebAssembly, GPL-3.0).
 * The Docker image carries a build of it (scripts/build-tabstationtoo.sh); the server serves
 * it at PS2_WEB_PREFIX with the cross-origin isolation its threads need, and an admin can
 * switch it off for everyone when it's too demanding for the family's PCs.
 */
export const PS2_WEB_PREFIX = "/emulators/ps2/";

/**
 * Headers for pages that run the emulator: its threads share memory, which browsers allow
 * only on a cross-origin isolated page.
 */
export const ISOLATION_HEADERS = {
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-embedder-policy": "require-corp",
  "cross-origin-resource-policy": "same-origin",
};

/**
 * LootDen's own play page around the emulator's frame. A frame is only isolated when the page
 * holding it is too; "credentialless" keeps cover art from other sites loading on that page.
 */
export const PLAY_PAGE_ISOLATION_HEADERS = {
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-embedder-policy": "credentialless",
};

export interface EmulationSettings {
  /** PS2 games can be played in the browser (on by default). */
  ps2Browser: boolean;
}

const KEY = "emulation";
const DEFAULTS: EmulationSettings = { ps2Browser: true };

export function loadEmulationSettings(db: Db): EmulationSettings {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(KEY) as { value: string } | undefined;
  return { ...DEFAULTS, ...json<Partial<EmulationSettings>>(row?.value, {}) };
}

export function saveEmulationSettings(db: Db, incoming: Partial<EmulationSettings>): EmulationSettings {
  const next = { ...loadEmulationSettings(db) };
  if (incoming.ps2Browser !== undefined) {
    if (typeof incoming.ps2Browser !== "boolean") throw new Error("ps2Browser is true or false");
    next.ps2Browser = incoming.ps2Browser;
  }
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(KEY, JSON.stringify(next));
  return next;
}

/** Whether PS2 games play in the browser here, and why not when they don't. */
export interface Ps2BrowserStatus {
  /** The admin's switch. */
  enabled: boolean;
  /** This server has the emulator's files. */
  installed: boolean;
  /** The PS2 BIOS on the server it would use. */
  bios: string | null;
  /** Everything is in place. */
  available: boolean;
  /** Why it isn't, in words for the player. */
  reason: string | null;
}

/**
 * The PS2 BIOS among the server's files: one uploaded for PCSX2, or else a 4 MB one whose name
 * fits (SCPH-39001.bin reads as a PS1 BIOS by name alone; PS1 BIOS files are 512 KB).
 */
export function ps2BiosFile(bios: ServerBiosFile[]): ServerBiosFile | undefined {
  const match = new RegExp(EMULATORS.find((e) => e.id === "pcsx2")!.bios[0]!.match, "i");
  const fits = bios.filter((f) => match.test(f.name));
  return fits.find((f) => f.emulator === "pcsx2") ?? fits.find((f) => f.size >= PS2_BIOS_BYTES);
}

const PS2_BIOS_BYTES = 4 * 1024 * 1024;

export function ps2BrowserStatus(db: Db, bios: ServerBiosFile[], dir: string): Ps2BrowserStatus {
  const enabled = loadEmulationSettings(db).ps2Browser;
  const installed = existsSync(path.join(dir, "index.html"));
  const file = ps2BiosFile(bios);
  const reason = !enabled
    ? "An admin turned off PS2 in the browser."
    : !installed
      ? "This server doesn't include the PS2 browser emulator."
      : !file
        ? "An admin needs to upload a PS2 BIOS under Emulation, Emulators and BIOS."
        : null;
  return { enabled, installed, bios: file?.name ?? null, available: reason === null, reason };
}

/** The emulator's page for one game: it fetches the BIOS and streams the disc from this server, then boots. */
export function ps2PlayUrl(game: GameDetail, biosName: string): string {
  const rom = browserPlayable(game);
  if (!rom) throw new Error("This game can't be played in the browser");
  const name = rom.path.split("/").pop()!;
  const bios = `/api/emulation/bios/${encodeURIComponent(biosName)}`;
  const disc = `/api/games/${encodeURIComponent(game.id)}/files/${rom.index}/${encodeURIComponent(name)}`;
  return `${PS2_WEB_PREFIX}index.html?${new URLSearchParams({ bios, disc })}`;
}
