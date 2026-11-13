// Builds standalone client executables into packages/client/release/.
//   node scripts/package.mjs            -> Windows x64, Linux x64 and Linux arm64
//   node scripts/package.mjs linux      -> both Linux builds
//   node scripts/package.mjs win        -> Windows only
// Each release folder gets the matching 7za so zip and 7z work without installing anything.
// RAR still needs a full 7-Zip install on the client machine.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const sevenBinDir = path.dirname(require.resolve("7zip-bin"));
const only = process.argv[2];

const targets = [
  { name: "win-x64", pkg: "node22-win-x64", exe: "lootden.exe", sevenZip: ["win", "x64", "7za.exe"] },
  { name: "linux-x64", pkg: "node22-linux-x64", exe: "lootden", sevenZip: ["linux", "x64", "7za"] },
  // ARM handhelds running Linux, such as a Retroid Pocket on Armada OS or ROCKNIX.
  { name: "linux-arm64", pkg: "node22-linux-arm64", exe: "lootden", sevenZip: ["linux", "arm64", "7za"] },
].filter((t) => !only || t.name.startsWith(only));

const bundle = path.join(root, "build", "lootden.cjs");
await build({
  entryPoints: [path.join(root, "dist", "src", "cli.js")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: bundle,
  logLevel: "warning",
  logOverride: { "empty-import-meta": "silent" },
});

for (const t of targets) {
  const out = path.join(root, "release", t.name);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  execFileSync("npx", ["--no-install", "pkg", bundle, "--targets", t.pkg, "--output", path.join(out, t.exe)], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  copyFileSync(path.join(sevenBinDir, ...t.sevenZip), path.join(out, t.sevenZip.at(-1)));
  console.log(`Built ${path.join(out, t.exe)}`);
}
