import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FetchLike } from "../metadata/http.js";

export const MANIFEST_URL = "https://raw.githubusercontent.com/mtkennerly/ludusavi-manifest/master/data/manifest.yaml";
const WEEK = 7 * 24 * 3600_000;

/** One place a game keeps saves or settings, in the placeholders LootDen's apps expand. */
export interface SaveLocation {
  /** Like %APPDATA%/StardewValley/Saves or {game}/saves/*.sav */
  template: string;
  tags: string[];
}

export interface ManifestGame {
  name: string;
  locations: SaveLocation[];
}

interface Entry {
  name: string;
  start: number;
  end: number;
}

/** "Stardew Valley™: Deluxe" and "stardew valley deluxe" match. */
export const manifestKey = (title: string) =>
  title
    .toLowerCase()
    .replace(/[™®©]/g, "")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "");

/** A YAML key or scalar, unquoted. */
export function unquote(s: string): string {
  const t = s.trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) return t.slice(1, -1).replace(/\\(["\\/])/g, "$1").replace(/\\t/g, "\t");
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) return t.slice(1, -1).replace(/''/g, "'");
  return t;
}

/** The key of a "key:" or "key: value" line (keys may be quoted and contain ": "). */
function keyOf(line: string): { key: string; rest: string } | null {
  const t = line.trimStart();
  if (t.startsWith('"') || t.startsWith("'")) {
    const q = t[0]!;
    let i = 1;
    while (i < t.length) {
      if (q === '"' && t[i] === "\\") i += 2;
      else if (t[i] === q && q === "'" && t[i + 1] === "'") i += 2;
      else if (t[i] === q) break;
      else i++;
    }
    if (t[i + 1] !== ":") return null;
    return { key: unquote(t.slice(0, i + 1)), rest: t.slice(i + 2).trim() };
  }
  const m = /^([^:]+?):(?:\s+(.*))?$/.exec(t);
  return m ? { key: m[1]!.trim(), rest: (m[2] ?? "").trim() } : null;
}

const indent = (line: string) => line.length - line.trimStart().length;

const PLACEHOLDERS: Record<string, string | null> = {
  "<base>": "{game}",
  "<home>": "%USERPROFILE%",
  "<storeUserId>": "*",
  "<osUserName>": "%USERNAME%",
  "<winAppData>": "%APPDATA%",
  "<winLocalAppData>": "%LOCALAPPDATA%",
  "<winLocalAppDataLow>": "%USERPROFILE%/AppData/LocalLow",
  "<winDocuments>": "%DOCUMENTS%",
  "<winPublic>": "%PUBLIC%",
  "<winProgramData>": "%PROGRAMDATA%",
  "<winDir>": "%WINDIR%",
  // Places LootDen can't work out on its own, or that aren't on Windows.
  "<root>": null,
  "<game>": null,
  "<xdgData>": null,
  "<xdgConfig>": null,
};

/** A manifest path as a Windows save template, or null when it can't be used. */
export function manifestPathToTemplate(p: string): string | null {
  let unknown = false;
  const out = p.replace(/<[A-Za-z]+>/g, (m) => {
    const v = PLACEHOLDERS[m];
    if (v === undefined || v === null) unknown = true;
    return v ?? "";
  });
  if (unknown || !/^(\{game\}|%[A-Z]+%)/.test(out)) return null;
  return out.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * Reads one game's block of the manifest: its files, with the "when" conditions that say which
 * OS and store each applies to. Only what a Windows PC (or Wine) can back up is kept.
 */
export function parseGameBlock(block: string, store: string | null): SaveLocation[] {
  const lines = block.split("\n");
  const out: SaveLocation[] = [];
  let inFiles = false;
  let cur: { path: string; tags: string[]; when: Array<{ os?: string; store?: string }>; section: string } | null = null;
  const flush = () => {
    if (!cur) return;
    const ok = !cur.when.length || cur.when.some((w) => (!w.os || w.os === "windows") && (!w.store || !store || w.store === store));
    const template = ok ? manifestPathToTemplate(cur.path) : null;
    if (template && !out.some((o) => o.template === template)) out.push({ template, tags: cur.tags });
    cur = null;
  };
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const ind = indent(line);
    if (ind === 2) {
      flush();
      inFiles = line.trim() === "files:";
      continue;
    }
    if (!inFiles) continue;
    if (ind === 4) {
      flush();
      const k = keyOf(line);
      if (k) cur = { path: k.key, tags: [], when: [], section: "" };
      continue;
    }
    if (!cur) continue;
    const t = line.trim();
    if (ind === 6) {
      cur.section = t.replace(/:$/, "");
      continue;
    }
    if (cur.section === "tags" && t.startsWith("- ")) cur.tags.push(unquote(t.slice(2)));
    else if (cur.section === "when") {
      const item = t.startsWith("- ");
      const kv = keyOf(item ? t.slice(2) : t);
      if (item || !cur.when.length) cur.when.push({});
      if (kv && (kv.key === "os" || kv.key === "store")) cur.when[cur.when.length - 1]![kv.key] = unquote(kv.rest);
    }
  }
  flush();
  return out;
}

/**
 * Ludusavi's manifest (github.com/mtkennerly/ludusavi-manifest): where thousands of PC games
 * keep their saves, gathered from PCGamingWiki. Downloaded once a week into the data folder
 * and looked up by Steam or GOG id, or by title, for other stores' games.
 */
export class LudusaviManifest {
  private text = "";
  private entries: Entry[] = [];
  private byTitle = new Map<string, Entry>();
  private bySteam = new Map<string, Entry>();
  private byGog = new Map<string, Entry>();
  private loading: Promise<void> | null = null;
  private loadedAt = 0;
  readonly file: string;

  constructor(
    dataDir: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.file = path.join(dataDir, "ludusavi", "manifest.yaml");
  }

  get size(): number {
    return this.entries.length;
  }

  /** Builds the lookup tables from the manifest's text. */
  index(text: string): void {
    this.text = text;
    this.entries = [];
    this.byTitle.clear();
    this.bySteam.clear();
    this.byGog.clear();
    let pos = 0;
    let cur: Entry | null = null;
    let section = "";
    while (pos < text.length) {
      let nl = text.indexOf("\n", pos);
      if (nl === -1) nl = text.length;
      const line = text.slice(pos, nl).replace(/\r$/, "");
      const c = line[0];
      if (c && c !== " " && c !== "#" && c !== "-" && line !== "---") {
        if (cur) cur.end = pos;
        const k = keyOf(line);
        cur = k ? { name: k.key, start: pos, end: text.length } : null;
        if (cur) {
          this.entries.push(cur);
          const key = manifestKey(cur.name);
          if (key && !this.byTitle.has(key)) this.byTitle.set(key, cur);
        }
        section = "";
      } else if (cur && line.startsWith("  ") && line[2] !== " ") {
        section = line.trim();
      } else if (cur && (section === "steam:" || section === "gog:") && /^ {4}id: /.test(line)) {
        const id = unquote(line.slice(8));
        (section === "steam:" ? this.bySteam : this.byGog).set(id, cur);
      }
      pos = nl + 1;
    }
    if (cur) cur.end = text.length;
  }

  /** Loads the manifest, downloading it when missing or a week old. */
  async ensure(): Promise<void> {
    if (this.entries.length && Date.now() - this.loadedAt < WEEK) return;
    this.loading ??= this.load().finally(() => (this.loading = null));
    return this.loading;
  }

  private async load(): Promise<void> {
    const s = await stat(this.file).catch(() => null);
    if (!s || Date.now() - s.mtimeMs > WEEK) {
      try {
        const res = await this.fetchImpl(MANIFEST_URL, { signal: AbortSignal.timeout(120_000) });
        if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
        const body = await res.text();
        if (!/^\S.*:\s*$/m.test(body.slice(0, 2000))) throw new Error("That isn't the Ludusavi manifest");
        await mkdir(path.dirname(this.file), { recursive: true });
        await writeFile(`${this.file}.part`, body);
        await rename(`${this.file}.part`, this.file);
      } catch (err) {
        // An old copy is better than none.
        if (!s) throw new Error(`Couldn't download Ludusavi's save list: ${(err as Error).message}`);
      }
    }
    this.index(await readFile(this.file, "utf8"));
    this.loadedAt = Date.now();
  }

  /** A game's save locations: by Steam id for Steam games, GOG id for GOG, else by title. */
  find(q: { title: string; steamAppId?: string | null; gogId?: string | null; store?: string | null }): ManifestGame | null {
    const e =
      (q.steamAppId && this.bySteam.get(q.steamAppId)) ||
      (q.gogId && this.byGog.get(q.gogId)) ||
      this.byTitle.get(manifestKey(q.title)) ||
      this.byTitle.get(manifestKey(q.title.replace(/\s*[:-]\s*(game of the year|goty|definitive|deluxe|complete|enhanced|remastered|anniversary)( edition)?\s*$/i, "")));
    if (!e) return null;
    return { name: e.name, locations: parseGameBlock(this.text.slice(e.start, e.end), q.store ?? null) };
  }
}
