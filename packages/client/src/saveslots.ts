import { cp, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

const exists = (p: string) => stat(p).then(() => true, () => false);

/** Moves a folder, copying when it's on another drive. */
async function move(from: string, to: string): Promise<void> {
  await mkdir(path.dirname(to), { recursive: true });
  try {
    await rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    await cp(from, to, { recursive: true });
    await rm(from, { recursive: true, force: true });
  }
}

export interface SaveSlotOptions {
  /** The game's save folder on this PC. */
  saveDir: string;
  /** Where each profile's saves wait while someone else plays: <slots>/<game>/<person>. */
  slotsDir: string;
  gameId: string;
  /** Who is about to play, and whose saves are in the save folder now (null: nobody's yet). */
  userId: number;
  owner: number | null;
  /** Fills the save folder from this person's newest backup on the server; false when there is none. */
  restoreFromServer?: () => Promise<boolean>;
}

/**
 * Kids sharing one Windows account share every game's save folder. Before a game starts,
 * the saves of whoever played last are put aside in their slot, and this person's are put
 * back (from their slot, else their newest backup on the server), so nobody plays on top of
 * someone else's progress. Nothing is deleted: a slot that gets replaced is kept as ".old".
 */
export async function switchSaveSlot(o: SaveSlotOptions): Promise<"same" | "swapped" | "restored" | "fresh"> {
  if (o.owner === null || o.owner === o.userId) return "same";
  const slot = (id: number) => path.join(o.slotsDir, o.gameId, String(id));
  const theirs = slot(o.owner);
  if (await exists(o.saveDir)) {
    if (await exists(theirs)) {
      await rm(`${theirs}.old`, { recursive: true, force: true });
      await rename(theirs, `${theirs}.old`);
    }
    await move(o.saveDir, theirs);
  }
  const mine = slot(o.userId);
  if (await exists(mine)) {
    await move(mine, o.saveDir);
    return "swapped";
  }
  if (o.restoreFromServer && (await o.restoreFromServer().catch(() => false))) return "restored";
  return "fresh";
}
