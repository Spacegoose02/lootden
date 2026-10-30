import { spawn } from "node:child_process";
import path from "node:path";
import { groupArchiveSets, setupKindOf, type GameFile } from "@lootden/shared";

/** What an archive holds, as far as setting up goes; "unreadable" when 7-Zip couldn't list it. */
export type PeekResult = "disc" | "installer" | "none" | "unreadable";

/** The first volume of each archive in a game, relative to the game's root. */
export function archivesToPeek(files: GameFile[]): GameFile[] {
  const byPath = new Map(files.map((f) => [f.path, f]));
  return groupArchiveSets(files.filter((f) => f.archive).map((f) => f.path))
    .map((s) => byPath.get(s.first))
    .filter((f): f is GameFile => !!f);
}

/** File names inside an archive, from 7-Zip's technical listing. Never asks for a password. */
export function listArchive(sevenZip: string, file: string, timeoutMs = 60_000): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(sevenZip, ["l", "-slt", "-ba", "-p", "-sccUTF-8", file], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`${path.basename(sevenZip)} exited with code ${code}: ${err.trim().slice(-300)}`));
      // Blocks of "Key = value" lines, one per entry; folders say "Folder = +" or "Attributes = D...".
      const names: string[] = [];
      for (const block of out.split(/\r?\n\s*\r?\n/)) {
        const name = block.match(/^Path = (.+)$/m)?.[1];
        if (!name || /^Folder = \+$/m.test(block) || /^Attributes = D/m.test(block)) continue;
        names.push(name.replace(/\\/g, "/"));
      }
      resolve(names);
    });
  });
}

/** Whether an archive holds a disc image or a setup program, without unpacking it. */
export async function peekArchive(sevenZip: string, file: string): Promise<PeekResult> {
  try {
    const names = await listArchive(sevenZip, file);
    return setupKindOf(names.map((p) => ({ path: p }))) ?? "none";
  } catch {
    return "unreadable";
  }
}
