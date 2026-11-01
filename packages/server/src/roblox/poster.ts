import { createHash } from "node:crypto";
import type { RobloxGame } from "@lootden/shared";
import type { FetchLike } from "../metadata/http.js";

/** Portrait posters, 2:3 like every other cover in the library. */
const W = 600;
const H = 900;
const ICON = 340;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Splits a title into at most three lines that fit the poster at the given size. */
export function titleLines(title: string, perLine: number, maxLines = 3): string[] {
  const words = title.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= perLine || !cur) cur = next;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1]!.replace(/\s*\S*$/, "")}…`;
    return kept;
  }
  return lines;
}

/** Only Roblox's own image servers: the addresses come from Roblox's API, but the server fetches them. */
const isRobloxImage = (url: string | null): url is string => {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "rbxcdn.com" || u.hostname.endsWith(".rbxcdn.com"));
  } catch {
    return false;
  }
};

/** A hue from the game's id, for the background when Roblox has no screenshot. */
const hueOf = (id: string) => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 360;

/**
 * The poster for a Roblox game, as an SVG with its pictures inside: the screenshot fills the
 * frame behind, darkened toward the bottom, with the square icon large in the middle and the
 * name underneath. Roblox only has square icons and wide screenshots, and neither fits a
 * portrait cover on its own.
 */
export function posterSvg(g: Pick<RobloxGame, "universeId" | "name">, icon: string | null, shot: string | null): string {
  const hue = hueOf(g.universeId);
  const fontSize = g.name.length > 34 ? 46 : g.name.length > 18 ? 54 : 64;
  const lines = titleLines(g.name, Math.floor((W - 80) / (fontSize * 0.56)));
  const iconX = (W - ICON) / 2;
  const iconY = 170;
  // Without an icon the name sits in the middle instead.
  const textY = icon ? iconY + ICON + 60 + fontSize * 0.8 : H / 2 - ((lines.length - 1) * fontSize * 1.12) / 2 + fontSize * 0.35;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="0.4" y2="1"><stop offset="0" stop-color="hsl(${hue} 60% 38%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360} 65% 14%)"/></linearGradient>
  <linearGradient id="shade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0.15"/><stop offset="0.45" stop-color="#000" stop-opacity="0.35"/><stop offset="1" stop-color="#000" stop-opacity="0.85"/></linearGradient>
  <filter id="blur" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="10"/></filter>
  <filter id="lift" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="14" stdDeviation="18" flood-color="#000" flood-opacity="0.55"/></filter>
  <clipPath id="round"><rect x="${iconX}" y="${iconY}" width="${ICON}" height="${ICON}" rx="56"/></clipPath>
</defs>
<rect width="${W}" height="${H}" fill="url(#bg)"/>
${shot ? `<image href="${shot}" xlink:href="${shot}" x="-40" y="-40" width="${W + 80}" height="${H + 80}" preserveAspectRatio="xMidYMid slice" filter="url(#blur)"/>` : ""}
<rect width="${W}" height="${H}" fill="url(#shade)"/>
${
  icon
    ? `<rect x="${iconX}" y="${iconY}" width="${ICON}" height="${ICON}" rx="56" fill="#000" filter="url(#lift)"/>
<image href="${icon}" xlink:href="${icon}" x="${iconX}" y="${iconY}" width="${ICON}" height="${ICON}" preserveAspectRatio="xMidYMid slice" clip-path="url(#round)"/>
<rect x="${iconX}" y="${iconY}" width="${ICON}" height="${ICON}" rx="56" fill="none" stroke="#fff" stroke-opacity="0.85" stroke-width="6"/>`
    : ""
}
<g font-family="'Segoe UI', 'Inter', system-ui, -apple-system, Roboto, Arial, sans-serif" text-anchor="middle" fill="#fff">
${lines.map((l, i) => `  <text x="${W / 2}" y="${textY + i * fontSize * 1.12}" font-size="${fontSize}" font-weight="800">${esc(l)}</text>`).join("\n")}
  <text x="${W / 2}" y="${H - 42}" font-size="26" font-weight="700" letter-spacing="6" fill-opacity="0.75">ROBLOX</text>
</g>
</svg>`;
}

/** Bumped when the poster's look changes, so browsers fetch the new one. */
const POSTER_STYLE = "2";

const IMAGE_HEADERS = {
  accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8,*/*;q=0.5",
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 LootDen",
};

export interface Poster {
  svg: string;
  pictures: boolean;
}

/** An image's type from its first bytes: PNG, JPEG, WebP or GIF. Null for anything else. */
export function imageType(b: Buffer): string | null {
  if (b.length >= 8 && b[0] === 0x89 && b.toString("latin1", 1, 4) === "PNG") return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  if (b.length >= 6 && b.toString("latin1", 0, 4) === "GIF8") return "image/gif";
  return null;
}

/** Builds and keeps the posters, fetching each game's pictures from Roblox once. */
export class RobloxPosters {
  private readonly made = new Map<string, Promise<Poster>>();

  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly log: { warn(o: object, m: string): void } = { warn: () => {} },
  ) {}

  /** Changes when the game's name or pictures do, so browsers drop an old poster. */
  static version(g: Pick<RobloxGame, "name" | "iconUrl" | "thumbnailUrl"> & { customCover?: string | null }): string {
    return createHash("sha256").update(`${POSTER_STYLE}\n${g.name}\n${g.iconUrl}\n${g.thumbnailUrl}\n${g.customCover ?? ""}`).digest("hex").slice(0, 10);
  }

  /** The poster, and whether Roblox's pictures made it in (without them it's only the name). */
  poster(g: RobloxGame): Promise<Poster> {
    const key = `${g.universeId}:${RobloxPosters.version(g)}`;
    let job = this.made.get(key);
    if (!job) {
      job = Promise.all([this.inline(g.iconUrl), this.inline(g.thumbnailUrl)]).then(([icon, shot]) => ({ svg: posterSvg(g, icon, shot), pictures: !!(icon || shot) }));
      // A poster made without its pictures (Roblox's image servers unreachable) is tried again next time.
      job.then(
        (p) => {
          if (!p.pictures && (g.iconUrl || g.thumbnailUrl)) this.made.delete(key);
        },
        () => this.made.delete(key),
      );
      if (this.made.size > 500) this.made.delete(this.made.keys().next().value!);
      this.made.set(key, job);
    }
    return job;
  }

  /** A picture as a data: address, so the SVG shows it inside an <img> (which never loads outside files). */
  private async inline(url: string | null): Promise<string | null> {
    if (!isRobloxImage(url)) return null;
    try {
      // Roblox's image servers answer some clients without a browser's headers with an error page.
      const res = await this.fetchImpl(url, { headers: IMAGE_HEADERS, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) {
        this.log.warn({ url, status: res.status }, "Roblox picture not fetched");
        return null;
      }
      const body = Buffer.from(await res.arrayBuffer());
      // The bytes say what the picture is: the servers' Content-Type isn't always an image one.
      const type = imageType(body);
      if (!type || body.length > 4 * 1024 * 1024) {
        this.log.warn({ url, contentType: res.headers.get("content-type"), bytes: body.length }, "Roblox picture isn't a usable image");
        return null;
      }
      return `data:${type};base64,${body.toString("base64")}`;
    } catch (err) {
      this.log.warn({ url, err: (err as Error).message }, "Roblox picture not fetched");
      return null;
    }
  }
}
