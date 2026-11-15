// Arcade games through TeknoParrot (Windows). LootDen never shows TeknoParrot's own window:
// it writes the player's profile (UserProfiles/<Name>.xml, copied from GameProfiles/ the first
// time) with the game's path, the controller setup saved for the devices plugged in and the
// link settings for a race, then starts TeknoParrotUi.exe --profile=<Name>.xml.
//
// Profiles are .NET XmlSerializer files: <GameProfile> with <GamePath>, <ConfigValues> of
// <FieldInformation> (CategoryName, FieldName, FieldValue, FieldType, FieldOptions) and
// <JoystickButtons> wrapping one <JoystickButtons> per input (ButtonName, InputMapping,
// DirectInputButton/XInputButton/RawInputButton, BindName...). LootDen edits them as text so
// every element it doesn't know about stays exactly as TeknoParrot wrote it.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  arcadeGame,
  arcadeProfileFor,
  pickBindingSet,
  type ArcadeBindingSet,
  type ArcadeDevice,
  type ConnectedInputs,
} from "@lootden/shared";
import { findExecutable } from "./launcher.js";

export const TEKNOPARROT_EXE = "TeknoParrotUi.exe";

/** DirectInput's keyboard and mouse: always there, never what makes a setup. */
const SYSTEM_GUIDS = new Set(["6f1d2b61-d5a0-11cf-bfc7-444553540000", "6f1d2b60-d5a0-11cf-bfc7-444553540000", "00000000-0000-0000-0000-000000000000"]);

// ---- Profile XML ---------------------------------------------------------------------

const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unescapeXml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** The text of the first <tag> in [xml], or null when it's missing or empty (<tag />). */
export function xmlText(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? unescapeXml(m[1]!) : null;
}

/** Sets the first top-level <tag>, adding it before </GameProfile> when the profile has none. */
export function setXmlText(xml: string, tag: string, value: string): string {
  const full = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>|<${tag}\\s*/>`);
  const el = `<${tag}>${escapeXml(value)}</${tag}>`;
  if (full.test(xml)) return xml.replace(full, () => el);
  return xml.replace(/(\s*)<\/GameProfile>/, (_m, ws: string) => `${ws}  ${el}${ws}</GameProfile>`);
}

export interface ProfileField {
  category: string;
  name: string;
  value: string;
  type: string;
  options: string[];
}

const FIELD_BLOCK = /<FieldInformation>[\s\S]*?<\/FieldInformation>/g;

/** The game's settings, as TeknoParrot shows them under Game Settings. */
export function profileFields(xml: string): ProfileField[] {
  return [...xml.matchAll(FIELD_BLOCK)].map((m) => {
    const b = m[0];
    return {
      category: xmlText(b, "CategoryName") ?? "",
      name: xmlText(b, "FieldName") ?? "",
      value: xmlText(b, "FieldValue") ?? "",
      type: xmlText(b, "FieldType") ?? "",
      options: [...b.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((o) => unescapeXml(o[1]!)),
    };
  });
}

/** Sets one setting by its name; false when the game has no such setting. */
export function setProfileField(xml: string, name: string, value: string): { xml: string; set: boolean } {
  let set = false;
  const out = xml.replace(FIELD_BLOCK, (b) => {
    if (set || xmlText(b, "FieldName") !== name) return b;
    set = true;
    return setXmlText(b, "FieldValue", value);
  });
  return { xml: out, set };
}

/** The one <JoystickButtons> wrapper and the entries inside it. */
function joystickSection(xml: string): { start: number; end: number; inner: string } | null {
  const open = xml.indexOf("<JoystickButtons>");
  const close = xml.lastIndexOf("</JoystickButtons>");
  if (open < 0 || close <= open) return null;
  const start = open + "<JoystickButtons>".length;
  return { start, end: close, inner: xml.slice(start, close) };
}

const ENTRY = /<JoystickButtons>[\s\S]*?<\/JoystickButtons>/g;

/** An entry's key: its InputMapping (the slot TeknoParrot feeds), or its ButtonName on old profiles. */
export function entryKey(entry: string): string {
  return xmlText(entry, "InputMapping") ?? `name:${xmlText(entry, "ButtonName") ?? ""}`;
}

/** Each input of the game, by key, as TeknoParrot saved it. */
export function profileButtons(xml: string): Record<string, string> {
  const section = joystickSection(xml);
  if (!section) return {};
  const out: Record<string, string> = {};
  for (const m of section.inner.matchAll(ENTRY)) out[entryKey(m[0])] ??= m[0];
  return out;
}

/** Puts saved inputs back in place of the profile's own, matched by key; inputs not in [buttons] stay. */
export function applyButtons(xml: string, buttons: Record<string, string>): { xml: string; applied: number } {
  const section = joystickSection(xml);
  if (!section) return { xml, applied: 0 };
  let applied = 0;
  const used = new Set<string>();
  const inner = section.inner.replace(ENTRY, (entry) => {
    const key = entryKey(entry);
    const saved = buttons[key];
    if (saved === undefined || used.has(key)) return entry;
    used.add(key);
    applied++;
    return saved;
  });
  return { xml: xml.slice(0, section.start) + inner + xml.slice(section.end), applied };
}

/** The DirectInput devices (by instance GUID) the inputs are bound to, and whether any use XInput. */
export function boundDevices(buttons: Record<string, string>): { guids: Array<{ guid: string; bindName: string | null }>; xinput: boolean } {
  const guids = new Map<string, string | null>();
  let xinput = false;
  for (const entry of Object.values(buttons)) {
    const di = entry.match(/<DirectInputButton>([\s\S]*?)<\/DirectInputButton>/)?.[1];
    const guid = di ? xmlText(di, "JoystickGuid")?.toLowerCase() : null;
    if (guid && !SYSTEM_GUIDS.has(guid) && !guids.has(guid)) guids.set(guid, xmlText(entry, "BindNameDi") ?? xmlText(entry, "BindName"));
    if (/<XInputButton>[\s\S]*?<\/XInputButton>/.test(entry) && /<BindNameXi>[^<]+<\/BindNameXi>/.test(entry)) xinput = true;
  }
  return { guids: [...guids].map(([guid, bindName]) => ({ guid, bindName })), xinput };
}

// ---- TeknoParrot on this PC ---------------------------------------------------------

/** Folders TeknoParrot is usually unpacked to, checked when the player hasn't pointed LootDen at one. LootDen's own copy comes first. */
export function teknoParrotCandidates(env: NodeJS.ProcessEnv = process.env, toolsDir?: string): string[] {
  const drives = ["C:", "D:", "E:"];
  const out: string[] = toolsDir ? [path.join(toolsDir, "teknoparrot")] : [];
  for (const d of drives) out.push(`${d}\\TeknoParrot`, `${d}\\Games\\TeknoParrot`, `${d}\\Emulators\\TeknoParrot`, `${d}\\Arcade\\TeknoParrot`);
  if (env.USERPROFILE) out.push(path.join(env.USERPROFILE, "TeknoParrot"), path.join(env.USERPROFILE, "Desktop", "TeknoParrot"), path.join(env.USERPROFILE, "Downloads", "TeknoParrot"));
  if (env.LOCALAPPDATA) out.push(path.join(env.LOCALAPPDATA, "TeknoParrot"));
  return out;
}

export async function isTeknoParrotDir(dir: string): Promise<boolean> {
  return Boolean(await stat(path.join(dir, TEKNOPARROT_EXE)).catch(() => null));
}

/** The TeknoParrot folder: the saved one if it's still there, else the first usual place that has it. */
export async function findTeknoParrot(saved: string | null | undefined, candidates = teknoParrotCandidates()): Promise<string | null> {
  if (saved && (await isTeknoParrotDir(saved))) return saved;
  for (const c of candidates) if (await isTeknoParrotDir(c)) return c;
  return null;
}

/** Profile names TeknoParrot has templates for (GameProfiles/*.xml). */
export async function availableProfiles(tpDir: string): Promise<string[]> {
  const names = await readdir(path.join(tpDir, "GameProfiles")).catch(() => [] as string[]);
  return names.filter((n) => /\.xml$/i.test(n)).map((n) => n.replace(/\.xml$/i, "")).sort((a, b) => a.localeCompare(b));
}

const userProfilePath = (tpDir: string, profile: string) => path.join(tpDir, "UserProfiles", `${profile}.xml`);

/** The player's profile, made from TeknoParrot's template the first time (as its Game Settings page does). */
export async function readUserProfile(tpDir: string, profile: string): Promise<string> {
  const user = userProfilePath(tpDir, profile);
  const existing = await readFile(user, "utf8").catch(() => null);
  if (existing !== null) return existing;
  const template = path.join(tpDir, "GameProfiles", `${profile}.xml`);
  if (!(await stat(template).catch(() => null))) throw new Error(`TeknoParrot has no ${profile} profile. Update TeknoParrot, or pick the game's profile on its page.`);
  await mkdir(path.dirname(user), { recursive: true });
  await copyFile(template, user);
  return readFile(user, "utf8");
}

/** Writes the profile beside itself and swaps it in, keeping the Windows line endings TeknoParrot uses. */
export async function writeUserProfile(tpDir: string, profile: string, xml: string): Promise<void> {
  const file = userProfilePath(tpDir, profile);
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.lootden.tmp`;
  await writeFile(temp, xml);
  await rename(temp, file);
}

// ---- LootDen's arcade settings on this PC ------------------------------------------

/** Kept in arcade.json in the tools folder: each PC has its own TeknoParrot and its own controllers. */
export interface ArcadeState {
  tpDir: string | null;
  /** Per game: the profile picked for it when LootDen couldn't tell, and a pinned controller setup. */
  games: Record<string, { profile?: string; pinned?: string | null }>;
  bindings: ArcadeBindingSet[];
}

const STATE = "arcade.json";

export async function readArcadeState(toolsDir: string): Promise<ArcadeState> {
  try {
    const s = JSON.parse(await readFile(path.join(toolsDir, STATE), "utf8")) as Partial<ArcadeState>;
    return { tpDir: s.tpDir ?? null, games: s.games ?? {}, bindings: s.bindings ?? [] };
  } catch {
    return { tpDir: null, games: {}, bindings: [] };
  }
}

export async function writeArcadeState(toolsDir: string, state: ArcadeState): Promise<void> {
  await mkdir(toolsDir, { recursive: true });
  const file = path.join(toolsDir, STATE);
  await writeFile(`${file}.tmp`, JSON.stringify(state, null, 2) + "\n");
  await rename(`${file}.tmp`, file);
}

// ---- Input devices (Windows) --------------------------------------------------------

/** Runs a program and returns what it printed; empty when it fails (it's only ever a hint). */
export type RunText = (cmd: string, args: string[]) => Promise<string>;

export const runText: RunText = (cmd, args) =>
  new Promise((resolve) => {
    let out = "";
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("error", () => resolve(""));
    child.on("close", () => resolve(out));
  });

const DINPUT_KEY = "HKCU\\System\\CurrentControlSet\\Control\\MediaProperties\\PrivateProperties\\DirectInput";
const OEM_KEY = "HKCU\\System\\CurrentControlSet\\Control\\MediaProperties\\PrivateProperties\\Joystick\\OEM";

/** A REG_BINARY GUID (16 bytes, the first three groups little-endian) as text. */
export function guidFromRegBinary(hex: string): string | null {
  const h = hex.replace(/\s+/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(h)) return null;
  const b = h.match(/../g)!;
  const le = (from: number, n: number) => b.slice(from, from + n).reverse().join("");
  return `${le(0, 4)}-${le(4, 2)}-${le(6, 2)}-${b.slice(8, 10).join("")}-${b.slice(10, 16).join("")}`;
}

/**
 * DirectInput's instance GUID for each device it has seen, by USB id, from `reg query /s`.
 * DirectInput keeps them under ...\DirectInput\VID_xxxx&PID_xxxx\Calibration\<n>, value GUID.
 */
export function parseDirectInputGuids(regOutput: string): Map<string, string> {
  const out = new Map<string, string>();
  let vidPid: string | null = null;
  for (const line of regOutput.split(/\r?\n/)) {
    const key = line.match(/VID_([0-9A-F]{4})&PID_([0-9A-F]{4})/i);
    if (/^HKEY_/i.test(line.trim())) vidPid = key ? `${key[1]!.toUpperCase()}:${key[2]!.toUpperCase()}` : null;
    const value = line.match(/^\s+GUID\s+REG_BINARY\s+([0-9A-Fa-f]+)/);
    if (value && vidPid) {
      const guid = guidFromRegBinary(value[1]!);
      if (guid) out.set(guid, vidPid);
    }
  }
  return out;
}

/** Device names Windows shows in Game Controllers ("Logitech G29 Driving Force Racing Wheel"), by USB id. */
export function parseOemNames(regOutput: string): Map<string, string> {
  const out = new Map<string, string>();
  let vidPid: string | null = null;
  for (const line of regOutput.split(/\r?\n/)) {
    if (/^HKEY_/i.test(line.trim())) {
      const key = line.match(/VID_([0-9A-F]{4})&PID_([0-9A-F]{4})/i);
      vidPid = key ? `${key[1]!.toUpperCase()}:${key[2]!.toUpperCase()}` : null;
    }
    const value = line.match(/^\s+OEMName\s+REG_SZ\s+(.+)$/);
    if (value && vidPid) out.set(vidPid, value[1]!.trim());
  }
  return out;
}

/** USB ids of the HID devices plugged in now, from PowerShell's list of present devices. */
export function parsePresentDevices(json: string): { vidPids: string[]; xinput: boolean } {
  let rows: Array<{ Name?: string; DeviceID?: string }> = [];
  try {
    const parsed = JSON.parse(json || "[]") as unknown;
    rows = (Array.isArray(parsed) ? parsed : [parsed]) as typeof rows;
  } catch {
    return { vidPids: [], xinput: false };
  }
  const vidPids = new Set<string>();
  let xinput = false;
  for (const r of rows) {
    const m = r.DeviceID?.match(/VID_([0-9A-F]{4})&PID_([0-9A-F]{4})/i);
    if (m) vidPids.add(`${m[1]!.toUpperCase()}:${m[2]!.toUpperCase()}`);
    // XInput pads show up as "...&IG_00" HID devices, or as "XINPUT compatible HID device".
    if (/&IG_\d+/i.test(r.DeviceID ?? "") || /xinput|xbox/i.test(r.Name ?? "")) xinput = true;
  }
  return { vidPids: [...vidPids], xinput };
}

/** What's plugged in now. On anything but Windows nothing is (TeknoParrot only runs there). */
export async function connectedInputs(run: RunText = runText, platform: NodeJS.Platform = process.platform): Promise<ConnectedInputs> {
  if (platform !== "win32") return { vidPids: [], xinput: false };
  const json = await run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "Get-PnpDevice -PresentOnly -Class HIDClass -ErrorAction SilentlyContinue | Select-Object FriendlyName,InstanceId | ForEach-Object { [pscustomobject]@{ Name = $_.FriendlyName; DeviceID = $_.InstanceId } } | ConvertTo-Json -Compress",
  ]);
  return parsePresentDevices(json);
}

/** The devices a set of inputs is bound to, named and with their USB ids where Windows knows them. */
export async function describeDevices(buttons: Record<string, string>, run: RunText = runText): Promise<ArcadeDevice[]> {
  const bound = boundDevices(buttons);
  const guids = parseDirectInputGuids(await run("reg", ["query", DINPUT_KEY, "/s", "/v", "GUID"]));
  const names = parseOemNames(await run("reg", ["query", OEM_KEY, "/s", "/v", "OEMName"]));
  const devices: ArcadeDevice[] = bound.guids.map(({ guid, bindName }) => {
    const vidPid = guids.get(guid) ?? null;
    // TeknoParrot's bind names start with the device ("Logitech G29 ... Buttons 5"); the last words are the control.
    const fallback = bindName?.replace(/\s+(Buttons\s*\d+|X ?Axis|Y ?Axis|Z ?Axis|Rx|Ry|Rz|Sliders\d.*|PointOfViewControllers.*|[+-])\s*$/i, "").trim();
    return { guid, vidPid, name: (vidPid && names.get(vidPid)) || fallback || "Controller" };
  });
  if (bound.xinput) devices.push({ guid: "xinput", vidPid: null, name: "Xbox controller" });
  return devices;
}

// ---- Controller setups -------------------------------------------------------------

/** The Input API setting, when the game lets the player choose one. */
const inputApiField = (xml: string) => profileFields(xml).find((f) => /^input api$/i.test(f.name));

/** Saves the profile's current controls as a setup for the devices they use, replacing an older one for the same devices. */
export async function captureBindings(toolsDir: string, tpDir: string, profile: string, name?: string, run: RunText = runText): Promise<ArcadeBindingSet> {
  const xml = await readUserProfile(tpDir, profile);
  const buttons = profileButtons(xml);
  if (!Object.keys(buttons).length) throw new Error(`The ${profile} profile has no controls to save yet`);
  const devices = await describeDevices(buttons, run);
  if (!devices.length) throw new Error("Those controls only use the keyboard. Bind your wheel or controller in TeknoParrot first.");
  const state = await readArcadeState(toolsDir);
  const same = (s: ArcadeBindingSet) => s.profile.toLowerCase() === profile.toLowerCase() && s.devices.map((d) => d.guid).sort().join() === devices.map((d) => d.guid).sort().join();
  const old = state.bindings.find(same);
  const set: ArcadeBindingSet = {
    id: old?.id ?? randomUUID(),
    profile,
    name: name?.trim() || old?.name || devices.map((d) => d.name).join(" + "),
    devices,
    inputApi: inputApiField(xml)?.value || null,
    buttons,
    savedAt: new Date().toISOString(),
  };
  state.bindings = [...state.bindings.filter((s) => s.id !== set.id), set];
  await writeArcadeState(toolsDir, state);
  return set;
}

/** Puts a setup's controls (and its Input API) into the profile text. */
export function applyBindingSet(xml: string, set: ArcadeBindingSet): { xml: string; applied: number } {
  let out = xml;
  if (set.inputApi) out = setProfileField(out, inputApiField(out)?.name ?? "Input API", set.inputApi).xml;
  return applyButtons(out, set.buttons);
}

// ---- Linked races ------------------------------------------------------------------

export interface LinkPlan {
  cabinet: number;
  total: number;
  /** This PC's address on the network the other PCs are on. */
  address: string | null;
}

/** This PC's private IPv4 address, the one a LAN race uses. */
export function lanAddress(interfaces = os.networkInterfaces()): string | null {
  const all = Object.values(interfaces).flat().filter((i): i is os.NetworkInterfaceInfo => !!i && i.family === "IPv4" && !i.internal);
  const isPrivate = (a: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a);
  return (all.find((i) => isPrivate(i.address)) ?? all[0])?.address ?? null;
}

/**
 * Fills in the link settings TeknoParrot has for the game: the network adapter's address and a
 * cabinet or seat number, matched by name since each game names them its own way. Returns what
 * it set; the game's own cabinet ID is set in its test menu (see ArcadeGame.link).
 */
export function applyLink(xml: string, link: LinkPlan): { xml: string; set: string[] } {
  let out = xml;
  const set: string[] = [];
  for (const f of profileFields(xml)) {
    let value: string | null = null;
    if (link.address && /(network\s*adapter|adapter\s*ip|^ip(\s*address)?$|network\s*ip|local\s*ip|bind\s*ip)/i.test(f.name)) value = link.address;
    else if (/(cab(inet)?\s*(id|number|no)|seat\s*(id|number|no)?|machine\s*(id|number))/i.test(f.name)) value = String(link.cabinet);
    else if (/(total|number of)\s*(linked\s*)?(cab(inet)?s|machines|seats)/i.test(f.name)) value = String(link.total);
    else if (/^(enable\s*)?(link|lan|network)\s*(play|mode|enable)?$/i.test(f.name) && /bool/i.test(f.type)) value = link.total > 1 ? "1" : "0";
    if (value === null || (f.options.length && !f.options.includes(value))) continue;
    out = setProfileField(out, f.name, value).xml;
    set.push(`${f.name} = ${value}`);
  }
  return { xml: out, set };
}

// ---- Playing -----------------------------------------------------------------------

/** Programs in an arcade dump that aren't the game: TeknoParrot's loaders and the cabinet's own services. */
const NOT_ARCADE_GAME = /^(amdaemon|inject(_x64|_x86)?|.*loader|openparrot.*|teknoparrot.*|budgie.*|parrot.*|serverbox.*|.*keychip.*|segaboot|nvcleanstall|dxsetup|vc_?redist.*)\.exe$/i;

/** The game's own program: the one already in the profile when it's in this folder, else LootDen's best guess. */
export async function arcadeExecutable(gameDir: string, title: string, profile: string, currentPath: string | null): Promise<string | null> {
  if (currentPath && path.resolve(currentPath).toLowerCase().startsWith(path.resolve(gameDir).toLowerCase() + path.sep) && (await stat(currentPath).catch(() => null))) {
    return path.relative(gameDir, currentPath);
  }
  // The profile from another PC or folder names the program: find the file with that name here.
  if (currentPath) {
    const want = path.win32.basename(currentPath).toLowerCase();
    const found = await findNamed(gameDir, want);
    if (found) return found;
  }
  const guess = await findExecutable(gameDir, `${title} ${profile}`, "win32");
  if (guess && !NOT_ARCADE_GAME.test(path.basename(guess))) return guess;
  return null;
}

async function findNamed(dir: string, lower: string, rel = "", depth = 0): Promise<string | null> {
  if (depth > 4) return null;
  const entries = await readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => []);
  for (const e of entries) if (e.isFile() && e.name.toLowerCase() === lower) return path.join(rel, e.name);
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const hit = await findNamed(dir, lower, path.join(rel, e.name), depth + 1);
    if (hit) return hit;
  }
  return null;
}

export interface ArcadeOptions {
  toolsDir: string;
  /** The executable chosen before (from the install manifest), relative to the game folder. */
  executable?: string | null;
  /** Sets TeknoParrot up when this PC doesn't have it, returning its folder. Without it, the player is asked to. */
  installTeknoParrot?: () => Promise<string>;
  link?: LinkPlan | null;
  run?: RunText;
  platform?: NodeJS.Platform;
  onEvent?: (e: { message: string }) => void;
}

export interface ArcadePlan {
  tpDir: string;
  profile: string;
  exe: string;
  args: string[];
  /** The game's program, relative to its folder: saved so the next start doesn't guess. */
  gameExe: string;
  bindings: ArcadeBindingSet | null;
  linkFields: string[];
  /** What to do in the game's test menu for a linked race. */
  linkSteps: string[];
}

export class ArcadeSetupNeeded extends Error {
  constructor(
    message: string,
    readonly need: "teknoparrot" | "profile" | "executable",
  ) {
    super(message);
  }
}

/** Works out the profile, fills it in and returns how to start the game. Nothing runs yet. */
export async function prepareArcade(gameId: string, gameDir: string, title: string, opts: ArcadeOptions): Promise<ArcadePlan> {
  if ((opts.platform ?? process.platform) !== "win32") throw new Error("Arcade games play through TeknoParrot, which runs on Windows only");
  const state = await readArcadeState(opts.toolsDir);
  let tpDir = await findTeknoParrot(state.tpDir, teknoParrotCandidates(process.env, opts.toolsDir));
  if (!tpDir && opts.installTeknoParrot) {
    opts.onEvent?.({ message: "TeknoParrot isn't on this PC yet: setting it up" });
    tpDir = await opts.installTeknoParrot();
  }
  if (!tpDir) throw new ArcadeSetupNeeded("Set up TeknoParrot first (Emulation, then Emulators, Arcade)", "teknoparrot");
  if (tpDir !== state.tpDir) {
    state.tpDir = tpDir;
    await writeArcadeState(opts.toolsDir, state);
  }
  const available = await availableProfiles(tpDir);
  const profile = state.games[gameId]?.profile ?? arcadeProfileFor(gameDir, title, available);
  if (!profile) throw new ArcadeSetupNeeded(`Pick ${title}'s TeknoParrot profile on its page first`, "profile");

  let xml = await readUserProfile(tpDir, profile);
  const gameExe = opts.executable && (await stat(path.join(gameDir, opts.executable)).catch(() => null)) ? opts.executable : await arcadeExecutable(gameDir, title, profile, xmlText(xml, "GamePath"));
  if (!gameExe) throw new ArcadeSetupNeeded(`Couldn't tell which program starts ${title}. Choose it on its page.`, "executable");
  xml = setXmlText(xml, "GamePath", path.join(gameDir, gameExe));

  const connected = await connectedInputs(opts.run, opts.platform);
  const bindings = pickBindingSet(state.bindings, profile, connected, state.games[gameId]?.pinned);
  if (bindings) {
    xml = applyBindingSet(xml, bindings).xml;
    opts.onEvent?.({ message: `Using the ${bindings.name} controls` });
  }

  let linkFields: string[] = [];
  if (opts.link) {
    const r = applyLink(xml, opts.link);
    xml = r.xml;
    linkFields = r.set;
  }
  await writeUserProfile(tpDir, profile, xml);
  if (bindings) {
    const fresh = await readArcadeState(opts.toolsDir);
    const b = fresh.bindings.find((s) => s.id === bindings.id);
    if (b) b.lastUsedAt = new Date().toISOString();
    await writeArcadeState(opts.toolsDir, fresh);
  }
  const known = arcadeGame(profile);
  return {
    tpDir,
    profile,
    exe: path.join(tpDir, TEKNOPARROT_EXE),
    // A bare file name, as TeknoParrot's own desktop shortcuts and front ends pass it; it looks in UserProfiles.
    args: [`--profile=${profile}.xml`],
    gameExe,
    bindings,
    linkFields,
    linkSteps: opts.link && opts.link.total > 1 ? (known?.link?.testMenu ?? ["Set this PC's cabinet number and the number of linked cabinets in the game's test menu."]) : [],
  };
}

/** Runs TeknoParrot (with a profile, the game; without, its own window) and waits for it to close. */
export function runTeknoParrot(exe: string, args: string[]): Promise<number> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd: path.dirname(exe), stdio: "ignore", windowsHide: false });
    child.on("error", reject);
    child.on("exit", () => resolve(Math.round((Date.now() - started) / 1000)));
  });
}

/**
 * Opens TeknoParrot's own window so the player can bind controls for a game, then saves what
 * they bound as a setup for the devices they used.
 */
export async function setControlsInTeknoParrot(toolsDir: string, profile: string, run: RunText = runText): Promise<ArcadeBindingSet> {
  const state = await readArcadeState(toolsDir);
  const tpDir = await findTeknoParrot(state.tpDir, teknoParrotCandidates(process.env, toolsDir));
  if (!tpDir) throw new ArcadeSetupNeeded("Set up TeknoParrot first", "teknoparrot");
  // The profile exists before TeknoParrot opens, so the game is in its list.
  await readUserProfile(tpDir, profile);
  await runTeknoParrot(path.join(tpDir, TEKNOPARROT_EXE), []);
  return captureBindings(toolsDir, tpDir, profile, undefined, run);
}
