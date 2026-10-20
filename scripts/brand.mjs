// Copies your own icons from brand/ to where the desktop app and the Playnite extension
// expect them. The web UI reads brand/ itself when it is built (packages/web/vite.config.ts).
// Run: npm run brand   (the desktop build runs it for you)
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const brand = path.join(root, "brand");
const targets = [
  ["icon.png", "packages/desktop/build/icon.png"],
  ["mascot.png", "packages/desktop/build/mascot.png"],
  ["playnite-icon.png", "playnite/LootDenLibrary/icon.png"],
];

for (const [name, target] of targets) {
  const from = path.join(brand, name);
  const to = path.join(root, target);
  if (!existsSync(from)) continue;
  if (existsSync(to) && readFileSync(from).equals(readFileSync(to))) continue;
  copyFileSync(from, to);
  console.log(`brand: ${name} -> ${target}`);
}
