// Emulators the desktop app can set up, and the BIOS/firmware each one needs.
// The app downloads emulators from their projects' own releases only. BIOS files come
// from the player's own consoles: picked on the PC, or uploaded once to the server by an admin.

export interface BiosRequirement {
  id: string;
  label: string;
  /** Case-insensitive pattern for file names that satisfy it. */
  match: string;
  /** Typical file names, shown as hints. */
  examples: string[];
  required: boolean;
  /** Folder inside the emulator's data folder. "firmware" means the emulator installs it itself. */
  folder: string;
  /** Only needed for this system (RetroArch covers many). */
  platform?: string;
  /** The console maker's own download page, when they publish the file. */
  officialUrl?: string;
  /** The app can fetch it from the emulator project's own releases. */
  autoFetch?: boolean;
}

export interface EmulatorInfo {
  id: string;
  name: string;
  homepage: string;
  platforms: string[];
  bios: BiosRequirement[];
  /** Whether LootDen backs up this emulator's saves after each session. */
  saveSync: boolean;
  note?: string;
}

export const EMULATORS: EmulatorInfo[] = [
  {
    id: "retroarch",
    name: "RetroArch",
    homepage: "https://www.retroarch.com/",
    platforms: ["nes", "snes", "n64", "gb", "gbc", "gba", "nds", "psp", "gamecube", "wii", "genesis", "saturn", "dreamcast"],
    saveSync: true,
    bios: [
      { id: "saturn", label: "Sega Saturn BIOS", match: "^(sega_101|mpr-17933)\\.bin$", examples: ["sega_101.bin", "mpr-17933.bin"], required: true, folder: "system", platform: "saturn" },
      { id: "dreamcast", label: "Dreamcast boot ROM (optional, improves compatibility)", match: "^dc_(boot|flash)\\.bin$", examples: ["dc_boot.bin", "dc_flash.bin"], required: false, folder: "system/dc", platform: "dreamcast" },
      { id: "nds", label: "Nintendo DS BIOS and firmware (optional)", match: "^(bios7|bios9|firmware)\\.bin$", examples: ["bios7.bin", "bios9.bin", "firmware.bin"], required: false, folder: "system", platform: "nds" },
    ],
    note: "Each system uses a RetroArch core, downloaded from the libretro buildbot the first time you play it.",
  },
  {
    id: "duckstation",
    name: "DuckStation",
    homepage: "https://www.duckstation.org/",
    platforms: ["ps1"],
    saveSync: true,
    bios: [{ id: "ps1", label: "PlayStation BIOS", match: "^(scph-?\\d{3,4}[a-z]?|ps-?\\d{2}[a-z]?|psxonpsp660|ps1_rom)\\.bin$", examples: ["scph5501.bin", "scph1001.bin", "scph7502.bin"], required: true, folder: "bios" }],
  },
  {
    id: "pcsx2",
    name: "PCSX2",
    homepage: "https://pcsx2.net/",
    platforms: ["ps2"],
    saveSync: true,
    bios: [{ id: "ps2", label: "PlayStation 2 BIOS", match: "^(?!xbox|mcpx|complex|evox)(scph|ps2|dtl|.*bios).*\\.(bin|rom0)$", examples: ["SCPH-70012_BIOS_V12_USA_200.BIN", "ps2-0230a-20080220.bin"], required: true, folder: "bios" }],
    note: "PCSX2 keeps every game on one memory card, so the newest card wins when you switch PCs.",
  },
  {
    id: "rpcs3",
    name: "RPCS3",
    homepage: "https://rpcs3.net/",
    platforms: ["ps3"],
    saveSync: true,
    bios: [
      {
        id: "ps3fw",
        label: "PS3 system software (firmware)",
        match: "^ps3updat\\.pup$",
        examples: ["PS3UPDAT.PUP"],
        required: true,
        folder: "firmware",
        officialUrl: "https://www.playstation.com/en-us/support/hardware/ps3/system-software/",
      },
    ],
    note: "PS3 games need to be decrypted folders (with PS3_GAME/USRDIR/EBOOT.BIN) or ISOs.",
  },
  {
    id: "xemu",
    name: "xemu",
    homepage: "https://xemu.app/",
    platforms: ["xbox"],
    saveSync: false,
    bios: [
      { id: "mcpx", label: "Xbox MCPX boot ROM", match: "^mcpx_?1\\.0\\.bin$", examples: ["mcpx_1.0.bin"], required: true, folder: "bios" },
      { id: "flash", label: "Xbox flash BIOS", match: "^(complex|xbox_?bios|evox|4627|5838|5713).*\\.bin$", examples: ["Complex_4627.bin"], required: true, folder: "bios" },
      { id: "hdd", label: "Xbox hard drive image", match: "^xbox_hdd\\.qcow2$", examples: ["xbox_hdd.qcow2"], required: true, folder: "bios", autoFetch: true },
    ],
    note: "Xbox saves live inside the hard drive image, so they stay on each PC for now.",
  },
];

export function emulatorInfo(id: string): EmulatorInfo | undefined {
  return EMULATORS.find((e) => e.id === id);
}

/** Which BIOS requirement a file name satisfies, if any. */
export function biosRequirementFor(fileName: string, emulator?: string): { emulator: EmulatorInfo; requirement: BiosRequirement } | null {
  for (const e of EMULATORS) {
    if (emulator && e.id !== emulator) continue;
    for (const r of e.bios) if (new RegExp(r.match, "i").test(fileName)) return { emulator: e, requirement: r };
  }
  return null;
}

/** RetroArch core per system: the libretro file name without _libretro.dll/.so. */
export const RETROARCH_CORES: Record<string, string> = {
  nes: "mesen",
  snes: "snes9x",
  n64: "mupen64plus_next",
  gb: "gambatte",
  gbc: "gambatte",
  gba: "mgba",
  nds: "melondsds",
  psp: "ppsspp",
  gamecube: "dolphin",
  wii: "dolphin",
  genesis: "genesis_plus_gx",
  saturn: "mednafen_saturn",
  dreamcast: "flycast",
};

/** A BIOS file an admin uploaded to the server for every player's emulators. */
export interface ServerBiosFile {
  name: string;
  emulator: string;
  size: number;
  sha1: string;
  uploadedAt: string;
}
