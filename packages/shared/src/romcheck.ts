/** A No-Intro or Redump DAT file an admin uploaded, for checking ROMs and disc images. */
export interface RomDat {
  id: number;
  /** The DAT's own name, like "Nintendo - Super Nintendo Entertainment System". */
  name: string;
  version: string | null;
  games: number;
  roms: number;
  uploadedAt: string;
}

/**
 * What checking a game's files against the DATs found:
 * - verified: every game file is a known good dump
 * - partial: some files are, others aren't (a hack, a patch, or an extra file)
 * - unknown: no DAT has it (a bad dump, a hack, or no DAT for that system yet)
 * - unchecked: the files can't be hashed without unpacking them (7z, CHD, RVZ)
 */
export type RomStatus = "verified" | "partial" | "unknown" | "unchecked";

export interface RomFileCheck {
  path: string;
  /** The DAT's name for the matching dump, or null. */
  match: string | null;
  sha1: string | null;
}

export interface RomCheck {
  gameId: string;
  status: RomStatus;
  /** The DAT game the files belong to, like "Super Mario World (USA)". */
  matched: string | null;
  dat: string | null;
  files: RomFileCheck[];
  checkedAt: string;
}

export interface RomCheckProgress {
  running: boolean;
  done: number;
  total: number;
  current: string | null;
}
