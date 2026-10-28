// Bundles the main and preload scripts (with the client engine inlined) and
// copies the matching 7za binaries so zip and 7z work out of the box.
import { cpSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

for (const entry of ["main", "preload", "browser-preload"]) {
  await build({
    entryPoints: [path.join(root, "src", `${entry}.ts`)],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    outfile: path.join(root, "dist", `${entry}.cjs`),
    external: ["electron"],
    logLevel: "warning",
    logOverride: { "empty-import-meta": "silent" },
  });
}

const sevenBin = path.dirname(require.resolve("7zip-bin"));
for (const [platform, file] of [["win", "7za.exe"], ["linux", "7za"]]) {
  const dest = path.join(root, "vendor", "7zip", platform);
  mkdirSync(dest, { recursive: true });
  cpSync(path.join(sevenBin, platform, "x64", file), path.join(dest, file));
}
console.log("Bundled desktop app into dist/");
