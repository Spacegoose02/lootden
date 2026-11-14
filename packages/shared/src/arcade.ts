// Arcade games played through TeknoParrot (Windows only). Each game lives in
// Emulation/arcade/<game folder>/ as the dumped game files; TeknoParrot runs it from a
// profile (GameProfiles/<Name>.xml is the template, UserProfiles/<Name>.xml the player's copy).
// LootDen fills the player's profile in (game path, controls for the wheel plugged in, link
// settings) and starts TeknoParrotUi.exe --profile=<Name>.xml, which skips TeknoParrot's window.

/** The Arcade system's id: its folder under Emulation/ and the value stored on each game. */
export const ARCADE_PLATFORM = "arcade";

/** TeknoParrot's own pages: where to get it (its installer sets it up and keeps it updated). */
export const TEKNOPARROT_HOME = "https://teknoparrot.com/";
export const TEKNOPARROT_DOWNLOAD = "https://teknoparrot.com/en/Home/Download";

/** How two or more PCs race each other, from the game's own operator manual. */
export interface ArcadeLink {
  /** Most cabinets the game links. */
  maxCabinets: number;
  /**
   * What each PC sets in the game's test menu: the game keeps its cabinet number in its own
   * settings, so LootDen tells the player rather than writing it.
   */
  testMenu: string[];
}

export interface ArcadeGame {
  /** TeknoParrot's profile name (GameProfiles/<profile>.xml), as TeknoParrot spells it. */
  profile: string;
  title: string;
  /** Case-insensitive pattern for library titles and folder names that are this game. */
  match: string;
  /** Whether it's a driving game that wants a wheel and pedals. */
  wheel: boolean;
  link?: ArcadeLink;
}

const DAYTONA_LINK: ArcadeLink = {
  maxCabinets: 8,
  testMenu: [
    "Press Test to open the test menu.",
    "Go to NETWORK SETTINGS and set CABINET ID to this PC's number.",
    "Set TOTAL LINKED CABINETS to the number of PCs racing.",
    "Confirm and let the game restart. Do this once on each PC.",
  ],
};

/**
 * Games LootDen knows the TeknoParrot profile for. Anything else still plays: name its folder
 * <Profile>.teknoparrot (the RetroBat convention) or pick the profile on the game's page.
 */
export const ARCADE_GAMES: ArcadeGame[] = [
  { profile: "Daytona3NSE", title: "Daytona Championship USA New Season Edition", match: "daytona.*(championship|usa|3).*(nse|new season)|daytona\\s*3\\s*nse", wheel: true, link: DAYTONA_LINK },
  { profile: "Daytona3", title: "Daytona Championship USA", match: "daytona.*championship|daytona\\s*(usa\\s*)?3\\b|^daytona3$", wheel: true, link: DAYTONA_LINK },
];

/** Folder suffixes that name a game's TeknoParrot profile, as RetroBat does: "Daytona3.teknoparrot". */
const PROFILE_SUFFIX = /\.(teknoparrot|parrot|game)$/i;

/**
 * The TeknoParrot profile for a game, from its folder name or title, or null when LootDen
 * can't tell (the player then picks one). [available] limits it to profiles TeknoParrot has.
 */
export function arcadeProfileFor(folder: string, title: string, available?: string[]): string | null {
  const base = folder.split(/[\\/]/).filter(Boolean).pop() ?? "";
  const pick = (name: string) => {
    if (!available) return name;
    return available.find((a) => a.toLowerCase() === name.toLowerCase()) ?? null;
  };
  if (PROFILE_SUFFIX.test(base)) {
    const hit = pick(base.replace(PROFILE_SUFFIX, ""));
    if (hit) return hit;
  }
  for (const name of [base, title]) {
    const known = ARCADE_GAMES.find((g) => new RegExp(g.match, "i").test(name));
    if (known) {
      const hit = pick(known.profile);
      if (hit) return hit;
    }
  }
  // A folder called just "Daytona3" or "WMMT5" is the profile name itself.
  if (available) {
    const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    return available.find((a) => squash(a) === squash(base) || squash(a) === squash(title)) ?? null;
  }
  return null;
}

export function arcadeGame(profile: string): ArcadeGame | undefined {
  return ARCADE_GAMES.find((g) => g.profile.toLowerCase() === profile.toLowerCase());
}

/** One input device a saved controller setup uses, as Windows' DirectInput knows it on that PC. */
export interface ArcadeDevice {
  /** DirectInput instance GUID TeknoParrot binds to; "xinput" for XInput pads (any one will do). */
  guid: string;
  /** USB vendor and product ("046D:C24F"), so LootDen can tell whether it's plugged in. Null when Windows didn't say. */
  vidPid: string | null;
  name: string;
}

/** A controller setup for one game on one PC: TeknoParrot's bindings, saved for the devices it used. */
export interface ArcadeBindingSet {
  id: string;
  profile: string;
  /** "G29 + shifter", or the device names when the player didn't name it. */
  name: string;
  devices: ArcadeDevice[];
  /** TeknoParrot's Input API for these bindings (DirectInput, XInput, RawInput), when the game has the choice. */
  inputApi: string | null;
  /** The profile's <JoystickButtons> entries, by their InputMapping (or ButtonName when there's none). */
  buttons: Record<string, string>;
  savedAt: string;
  lastUsedAt?: string;
}

/** What's plugged in right now, for choosing a setup. */
export interface ConnectedInputs {
  vidPids: string[];
  /** Whether an XInput controller (an Xbox pad or one acting like it) is connected. */
  xinput: boolean;
}

/** Whether every device a setup needs is plugged in. Devices Windows couldn't name count as there. */
export function bindingSetReady(set: ArcadeBindingSet, connected: ConnectedInputs): boolean {
  const have = new Set(connected.vidPids.map((v) => v.toUpperCase()));
  return set.devices.every((d) => (d.guid === "xinput" ? connected.xinput : !d.vidPid || have.has(d.vidPid.toUpperCase())));
}

/**
 * The setup to use for a game: among the ones whose devices are all plugged in, the one using
 * the most devices (wheel, pedals and shifter beat the wheel alone, which beats a pad), then the
 * one used or saved last. A setup the player pinned wins while its devices are there.
 */
export function pickBindingSet(sets: ArcadeBindingSet[], profile: string, connected: ConnectedInputs, pinned?: string | null): ArcadeBindingSet | null {
  const ready = sets.filter((s) => s.profile.toLowerCase() === profile.toLowerCase() && bindingSetReady(s, connected));
  const pin = pinned ? ready.find((s) => s.id === pinned) : undefined;
  if (pin) return pin;
  const known = (s: ArcadeBindingSet) => s.devices.filter((d) => d.vidPid || d.guid === "xinput").length;
  const when = (s: ArcadeBindingSet) => Date.parse(s.lastUsedAt ?? s.savedAt) || 0;
  return ready.sort((a, b) => known(b) - known(a) || b.devices.length - a.devices.length || when(b) - when(a))[0] ?? null;
}

/** A linked race forming on the server: who's in, and each PC's cabinet number. */
export interface ArcadeLobby {
  gameId: string;
  profile: string | null;
  members: Array<{ device: string; name: string; address: string | null; cabinet: number; joinedAt: string }>;
  maxCabinets: number;
}
