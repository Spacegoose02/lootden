import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

/**
 * Your own logos from brand/ at the top of the repository. Each file is optional; anything
 * missing falls back to the built-in LootDen raccoon in public/.
 */
const BRAND = path.resolve(__dirname, "../../brand");
const FALLBACK = path.resolve(__dirname, "public");
const TYPES: Record<string, string> = { ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".ico": "image/x-icon", ".jpg": "image/jpeg" };

const find = (names: string[], fallback?: string) => {
  for (const n of names) if (existsSync(path.join(BRAND, n))) return path.join(BRAND, n);
  return fallback && existsSync(path.join(FALLBACK, fallback)) ? path.join(FALLBACK, fallback) : null;
};

/** Whether a brand file is the stock LootDen raccoon (brand/ ships a copy of it). */
function isBuiltIn(file: string | null): boolean {
  if (!file || path.extname(file) !== ".svg") return false;
  const stock = path.join(FALLBACK, "logo.svg");
  return file === stock || readFileSync(file, "utf8") === readFileSync(stock, "utf8");
}

export function brandFiles() {
  const logo = find(["logo.svg", "logo.png", "logo.webp"], "logo.svg");
  const files: Record<string, string | null> = {
    logo,
    wordmark: find(["wordmark.svg", "wordmark.png", "wordmark.webp"]),
    favicon: find(["favicon.svg", "favicon.png", "favicon.ico"]) ?? logo,
    touch: find(["apple-touch-icon.png", "icon.png"]),
    mascot: find(["mascot.png", "mascot.webp", "mascot.svg"]),
  };
  // Served at /brand/<kind><ext>.
  const urls = Object.fromEntries(Object.entries(files).map(([k, f]) => [k, f ? `/brand/${k}${path.extname(f)}` : null])) as Record<keyof typeof files, string | null>;
  return { files, urls };
}

export function brandPlugin(): Plugin {
  const { files, urls } = brandFiles();
  return {
    name: "lootden-brand",
    // The built-in raccoon is drawn inline so it takes the theme's colours; your own logo stays as it is.
    config: () => ({ define: { __BRAND__: JSON.stringify({ logo: urls.logo, wordmark: urls.wordmark, mascot: urls.mascot, raccoon: isBuiltIn(files.logo), raccoonFavicon: isBuiltIn(files.favicon) }) } }),
    transformIndexHtml: () =>
      [
        urls.favicon && { tag: "link", attrs: { rel: "icon", type: TYPES[path.extname(urls.favicon)], href: urls.favicon }, injectTo: "head" as const },
        urls.touch && { tag: "link", attrs: { rel: "apple-touch-icon", href: urls.touch }, injectTo: "head" as const },
      ].filter((t) => !!t),
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const kind = req.url?.match(/^\/brand\/(\w+)\./)?.[1];
        const file = kind ? files[kind] : null;
        if (!file) return next();
        res.setHeader("Content-Type", TYPES[path.extname(file)] ?? "application/octet-stream");
        res.end(readFileSync(file));
      });
    },
    generateBundle() {
      for (const [kind, file] of Object.entries(files)) {
        if (file) this.emitFile({ type: "asset", fileName: `brand/${kind}${path.extname(file)}`, source: readFileSync(file) });
      }
    },
  };
}
