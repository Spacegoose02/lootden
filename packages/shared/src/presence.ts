/**
 * Now Playing, parent controls and the household's PCs: the desktop app reports what runs on
 * its PC every half minute, the server keeps it for the Home page and the family board, and
 * hands back anything a parent sent to that PC (a message, "close the game").
 */

/** Where a running game came from. */
export type PlaySource = "lootden" | "emulated" | "roblox" | "store";

/** One game running on a PC, as the desktop app sees it. */
export interface RunningGame {
  /** A LootDen game id, `roblox:<placeId>`, or `store:<addon>:<externalId>` for other launchers. */
  gameId: string;
  title: string;
  source: PlaySource;
  /** The launcher's name for store games ("Steam", "Epic"). */
  store?: string;
  startedAt: string;
}

/** A PC's drive, for the free space on the PCs page. */
export interface PcDisk {
  path: string;
  freeBytes: number;
  totalBytes: number;
}

/** What a desktop app says about its PC alongside the heartbeat. */
export interface PcReport {
  /** The network cards' MAC addresses, for Wake-on-LAN. */
  macs?: string[];
  /** IPv4 addresses on the home network. */
  addresses?: string[];
  platform?: string;
  appVersion?: string;
  disks?: PcDisk[];
  /** Sunshine (game streaming host) is installed on this PC. */
  sunshine?: boolean;
  /** Moonlight (game streaming player) is installed on this PC. */
  moonlight?: boolean;
  /** LootDen games added to Sunshine on this PC, so they can be streamed from it. */
  streamGames?: string[];
  /**
   * The version of each LootDen PC game installed here, when known, so the server can tell
   * when a PC holds a newer copy than the library (see LibraryRefresh).
   */
  copies?: PcCopy[];
}

/** A LootDen game installed on a PC, at the version the PC knows it's at. */
export interface PcCopy {
  gameId: string;
  version: string;
  /** The version came from the game's exe: it was updated outside LootDen. */
  fromExe?: boolean;
}

/** POST /api/me/presence: the desktop app's heartbeat. */
export interface PresenceReport {
  device: string;
  playing: RunningGame[];
  pc?: PcReport;
}

/** Something a parent sent to a PC; the desktop app picks it up with its next heartbeat. */
export type PcCommand =
  | { id: string; kind: "message"; text: string; from: string }
  | { id: string; kind: "close"; gameId: string; from: string; text?: string }
  /** Send to PC: download and install a LootDen game there. */
  | { id: string; kind: "install"; gameId: string; title: string; from: string }
  /**
   * Refresh the library copy: zip this PC's install of the game and upload it to the server
   * in place of the library's older copy. `ticket` lets the upload through without an admin
   * profile signed in on that PC; it works once, for this game only.
   */
  | { id: string; kind: "refresh-copy"; gameId: string; title: string; version: string; ticket: string; from: string };

/** A library game that a household PC has a newer copy of than the server does. */
export interface RefreshCandidate {
  gameId: string;
  title: string;
  coverUrl: string | null;
  /** The library copy's own version (null when its name doesn't say). */
  libraryVersion: string | null;
  /** Newest version the server has counting its updates. */
  latestVersion: string | null;
  /** Updates on the server that the refresh makes unnecessary (moved out afterwards). */
  updates: Array<{ id: string; title: string; version: string | null; sizeBytes: number }>;
  /** Other full copies of the game, older than the PC's, that go too. */
  oldCopies: Array<{ id: string; title: string; version: string | null; sizeBytes: number }>;
  sizeBytes: number;
  /** PCs with a newer copy, newest version first. */
  pcs: Array<{ device: string; version: string; fromExe: boolean; online: boolean }>;
}

/** A refresh an admin started: where it's at. */
export interface RefreshJob {
  ticket: string;
  gameId: string;
  title: string;
  device: string;
  version: string;
  state: "waiting" | "uploading" | "done" | "failed";
  message: string | null;
  startedAt: string;
  /** The game's id once the new copy is in (it changes with the file name). */
  newGameId: string | null;
}

/** The server's answer to a heartbeat. */
export interface PresenceAnswer {
  commands: PcCommand[];
  /** Seconds until the next heartbeat. */
  nextInSeconds: number;
}

/** A game someone is playing right now, for the family board. */
export interface NowPlaying {
  userId: number;
  name: string;
  avatar: string;
  kid: boolean;
  device: string;
  gameId: string;
  title: string;
  source: PlaySource;
  store: string | null;
  /** Server-relative cover, when LootDen knows one. */
  coverUrl: string | null;
  /** A LootDen page for the game, when there is one. */
  href: string | null;
  startedAt: string;
  /** Play time left today, when this person has a daily limit. */
  remainingSeconds: number | null;
  /** The viewer can message this PC or close the game (admins). */
  canControl: boolean;
}

/** A household PC the desktop app runs on, for Settings, PCs. */
export interface PcInfo {
  name: string;
  online: boolean;
  lastSeenAt: string;
  /** Whoever was signed in to the app last. */
  lastUser: string | null;
  macs: string[];
  addresses: string[];
  platform: string | null;
  appVersion: string | null;
  disks: PcDisk[];
  sunshine: boolean;
  moonlight: boolean;
  /** LootDen games this PC streams with Sunshine. */
  streamGames: string[];
  /** What runs there now. */
  playing: Array<Pick<NowPlaying, "title" | "name" | "startedAt">>;
}

/** Heartbeats every 30 seconds; a PC not heard from in 90 is offline and its games have stopped. */
export const PRESENCE_INTERVAL_SECONDS = 30;
export const PRESENCE_TIMEOUT_SECONDS = 90;

const MAC = /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i;

/** A MAC address as aa:bb:cc:dd:ee:ff, or null when it isn't one (or is all zeros). */
export function cleanMac(input: unknown): string | null {
  const s = String(input ?? "").trim();
  if (!MAC.test(s)) return null;
  const mac = s.toLowerCase().replace(/-/g, ":");
  return mac === "00:00:00:00:00:00" ? null : mac;
}

/** The Wake-on-LAN magic packet: six 0xff bytes, then the MAC sixteen times. */
export function magicPacket(mac: string): Uint8Array {
  const clean = cleanMac(mac);
  if (!clean) throw new Error("That isn't a MAC address");
  const bytes = clean.split(":").map((h) => parseInt(h, 16));
  const out = new Uint8Array(6 + 16 * 6);
  out.fill(0xff, 0, 6);
  for (let i = 0; i < 16; i++) out.set(bytes, 6 + i * 6);
  return out;
}

/** Store game ids the desktop app reports: `store:<addon>:<externalId>`. */
export function storePlayId(addon: string, externalId: string): string {
  return `store:${addon}:${externalId}`;
}

/** A message a parent sends: one line, kept short enough for a notification. */
export function cleanPcMessage(input: unknown): string {
  const s = String(input ?? "").replace(/\s+/g, " ").trim();
  if (!s) throw new Error("Write a message first");
  return s.slice(0, 160);
}

/** "42 min", "1 h 5 min": how long a game has been running. */
export function playedFor(startedAt: string, now = Date.now()): string {
  const mins = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 60_000));
  if (mins < 1) return "just started";
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)} h${mins % 60 ? ` ${mins % 60} min` : ""}`;
}

// ---- Game night ----------------------------------------------------------------------

/** A planned family game night. */
export interface GameNight {
  id: number;
  title: string;
  /** YYYY-MM-DD and HH:MM in the household's time zone. */
  date: string;
  time: string;
  players: Array<{ id: number; name: string; avatar: string }>;
  game: { id: string; title: string; coverUrl: string | null } | null;
  note: string | null;
  /** The Den Duty family goal that earned it. */
  goal: { id: string; title: string; icon: string } | null;
  createdBy: string | null;
}

/** A game the picker suggests for the players chosen, with why. */
export interface GameNightPick {
  id: string;
  title: string;
  coverUrl: string | null;
  together: string[];
  /** How many of the players have it installed somewhere. */
  installedFor: number;
  players: number;
  reasons: string[];
  score: number;
}

/** Text for an iCalendar line: backslashes, semicolons, commas and newlines escaped. */
export function icsText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

// ---- Screenshot wall -------------------------------------------------------------------

export const SCREENSHOT_REACTIONS = ["😂", "🔥", "😮", "❤️", "👏", "🏆"] as const;
export type ScreenshotReaction = (typeof SCREENSHOT_REACTIONS)[number];

/** A screenshot on the family wall. */
export interface Screenshot {
  id: number;
  imageUrl: string;
  by: { id: number; name: string; avatar: string };
  game: { id: string | null; title: string } | null;
  caption: string | null;
  width: number | null;
  height: number | null;
  createdAt: string;
  /** Emoji to how many, and which ones this viewer gave. */
  reactions: Array<{ emoji: string; count: number; mine: boolean }>;
  canDelete: boolean;
}

/** What the Den Duty family wall shows from LootDen. */
export interface FamilyWall {
  nowPlaying: Array<{ name: string; avatar: string; title: string; device: string; startedAt: string; playedFor: string }>;
  nextGameNight: GameNight | null;
  screenshots: Array<{ id: number; imageUrl: string; by: string; game: string | null; caption: string | null; createdAt: string }>;
}

/** JPEG, PNG or WebP by their first bytes; null for anything else. */
export function imageKind(bytes: Uint8Array): "jpg" | "png" | "webp" | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes.length > 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "webp";
  return null;
}

/** A PC that can stream a game (Sunshine has it), for the game page's Stream button. */
export interface StreamHost {
  name: string;
  /** Its home network addresses, for Moonlight. */
  addresses: string[];
  online: boolean;
}
