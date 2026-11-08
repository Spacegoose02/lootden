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
    icon: find(["icon.png"]),
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
        { tag: "link", attrs: { rel: "apple-touch-icon", href: urls.touch ?? "/apple-touch-icon.png" }, injectTo: "head" as const },
        { tag: "link", attrs: { rel: "manifest", href: "/manifest.webmanifest" }, injectTo: "head" as const },
        { tag: "meta", attrs: { name: "apple-mobile-web-app-capable", content: "yes" }, injectTo: "head" as const },
        { tag: "meta", attrs: { name: "mobile-web-app-capable", content: "yes" }, injectTo: "head" as const },
      ].filter((t) => !!t),
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url === "/manifest.webmanifest") {
          res.setHeader("Content-Type", "application/manifest+json");
          return res.end(manifest(files, urls));
        }
        next();
      });
      server.middlewares.use((req, res, next) => {
        const kind = req.url?.match(/^\/brand\/(\w+)\./)?.[1];
        const file = kind ? files[kind] : null;
        if (!file) return next();
        res.setHeader("Content-Type", TYPES[path.extname(file)] ?? "application/octet-stream");
        res.end(readFileSync(file));
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "manifest.webmanifest", source: manifest(files, urls) });
      for (const [kind, file] of Object.entries(files)) {
        if (file) this.emitFile({ type: "asset", fileName: `brand/${kind}${path.extname(file)}`, source: readFileSync(file) });
      }
    },
  };
}

/**
 * The web app manifest, so phones and PCs can install LootDen as an app. The raccoon's
 * PNG icons come from public/; your own logo and icon.png from brand/ are used instead.
 */
function manifest(files: ReturnType<typeof brandFiles>["files"], urls: ReturnType<typeof brandFiles>["urls"]): string {
  const icons = isBuiltIn(files.logo)
    ? [
        { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
        { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      ]
    : [
        // brand/icon.png (a big square PNG) is what installed apps use; it's scaled down for the 192 slot.
        ...(files.icon ? [{ src: "/brand/icon.png", sizes: pngSize(files.icon) === "512x512" ? "192x192 512x512" : pngSize(files.icon), type: "image/png" }] : []),
        ...(urls.touch && files.touch ? [{ src: urls.touch, sizes: pngSize(files.touch), type: "image/png" }] : []),
        ...(urls.logo && files.logo ? [{ src: urls.logo, sizes: path.extname(files.logo) === ".png" ? pngSize(files.logo) : "any", type: TYPES[path.extname(urls.logo)] }] : []),
      ];
  return JSON.stringify(
    {
      name: "LootDen",
      short_name: "LootDen",
      description: "The family game library",
      id: "/",
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: "#120c24",
      theme_color: "#120c24",
      icons,
      shortcuts: [
        { name: "Library", url: "/" },
        { name: "Requests", url: "/requests" },
        { name: "Profile", url: "/profile" },
      ],
    },
    null,
    2,
  );
}

/** "WxH" from a PNG's header. */
function pngSize(file: string): string {
  const b = readFileSync(file);
  return b.length > 24 && b.toString("latin1", 1, 4) === "PNG" ? `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}` : "any";
}
