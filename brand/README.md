# Your logos

Drop your own files in this folder, keeping these exact names. Every file is optional: anything
you leave out keeps the built-in LootDen raccoon (the theme-coloured one drawn in
`packages/web/public/logo.svg`).

| File | Used for | Size |
| --- | --- | --- |
| `logo.svg` (or `logo.png`, `logo.webp`) | The top bar and the sign-in page; also the browser tab icon unless you add a favicon | Square. SVG is best; PNG at least 256 × 256 |
| `wordmark.svg` (or `.png`, `.webp`) | Replaces the logo and the "LootDen" text in the top bar | Wide, shown 36 px tall |
| `favicon.svg` (or `favicon.png`, `favicon.ico`) | The browser tab icon | 32 × 32 or larger, or SVG |
| `mascot.png` (or `.webp`, `.svg`) | The big picture on the sign-in page and the desktop app's connect screen (falls back to the logo) | Square, 512 × 512 |
| `apple-touch-icon.png` | Home-screen icon on phones and tablets (falls back to `icon.png`) | 180 × 180 |
| `icon.png` | The desktop app: window, taskbar and the Windows and Linux installers | 512 × 512 PNG |
| `playnite-icon.png` | The Playnite extension's icon | 512 × 512 PNG |

## Where they take effect

- **Web UI and the Docker image**: when the web UI is built (`npm run build`, or `docker build`).
  Rebuild after changing a file.
- **Desktop app**: `npm run build:desktop` (and the `dist` scripts) copy `icon.png` and `mascot.png` into
  `packages/desktop/build/` first.
- **Playnite extension**: run `npm run brand` before building it in Visual Studio; it copies
  `playnite-icon.png` into `playnite/LootDenLibrary/`.

The files here now are the current LootDen ones, so replacing them is all it takes.
