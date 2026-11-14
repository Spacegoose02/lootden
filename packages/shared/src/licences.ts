// PS3 licence files (.rap): the keys PSN games need, which the emulator looks for as
// dev_hdd0/home/<user>/exdata/<CONTENT_ID>.rap.

/** A licence an admin uploaded for one game, for every player's emulator. */
export interface GameLicence {
  /** <CONTENT_ID>.rap, the name RPCS3 and ARMSX3 look for. */
  name: string;
  /** The content id it unlocks, e.g. UP0001-BLUS30001_00-0000000000000001. */
  contentId: string;
  size: number;
  uploadedAt: string;
}

/** A RAP is exactly this many bytes: one encrypted 128-bit key. */
export const RAP_BYTES = 16;

/** Platforms whose games can carry licence files. */
export const LICENCE_PLATFORMS = ["ps3"];

/** XX0000-AAAA00000_00-<16 characters>: region and publisher, title id, then the item's own label. */
const CONTENT_ID = /^[A-Z]{2}\d{4}-[A-Z]{4}\d{5}_\d{2}-[A-Z0-9_]{16}$/;

/** The content id in a text, or null: "up0001-blus30001_00-abcdefabcdef0001" and "UP0001-…(1)" both work. */
export function contentIdIn(text: string): string | null {
  const m = text.toUpperCase().match(/[A-Z]{2}\d{4}-[A-Z]{4}\d{5}_\d{2}-[A-Z0-9_]{16}/);
  return m && CONTENT_ID.test(m[0]) ? m[0] : null;
}

/** The file name a licence must have for the emulator to find it: the content id in capitals, then ".rap". */
export function rapFileName(contentId: string): string {
  const id = contentId.toUpperCase();
  if (!CONTENT_ID.test(id)) throw new Error(`${contentId} isn't a PS3 content id (like UP0001-BLUS30001_00-0000000000000001)`);
  return `${id}.rap`;
}

/** The content id a PS3 package (.pkg) is for, from its header, or null for anything else. */
export function pkgContentId(head: Uint8Array): string | null {
  if (head.length < 0x30 + 36) return null;
  if (head[0] !== 0x7f || head[1] !== 0x50 || head[2] !== 0x4b || head[3] !== 0x47) return null;
  let text = "";
  for (let i = 0x30; i < 0x30 + 36; i++) text += String.fromCharCode(head[i]!);
  return CONTENT_ID.test(text) ? text : null;
}
