import { copyFile, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RecompLookId } from "@lootden/shared";
import { download, findFile } from "./emulators.js";
import { extractArchive, type SevenZip } from "./extractor.js";

// Looks: screen filters for recomps on Windows, run through ReShade (reshade.me). ReShade is downloaded
// once from its developer. Nothing is installed into Windows: when a recomp starts with a look, ReShade
// goes beside its program as dxgi.dll for that session (Direct3D 10, 11 and 12) and is taken away when
// it closes. Its settings, the filters and its log live in the recomp's own folder.

type Fetch = typeof fetch;

/** The filters, written for LootDen. One file, one technique per look, all sharing a Strength setting. */
export const LOOKS_FX = String.raw`// LootDen looks: small screen filters for recomps.
uniform float Strength < ui_type = "slider"; ui_min = 0.0; ui_max = 1.0; ui_label = "Strength"; > = 0.6;
uniform float Lines < ui_type = "slider"; ui_min = 120.0; ui_max = 1080.0; ui_label = "CRT lines"; > = 240.0;
uniform int Frame < source = "framecount"; >;

texture LootDenBackBufferTex : COLOR;
sampler LootDenBackBuffer { Texture = LootDenBackBufferTex; };

void LootDenVS(in uint id : SV_VertexID, out float4 position : SV_Position, out float2 uv : TEXCOORD)
{
	uv.x = (id == 2) ? 2.0 : 0.0;
	uv.y = (id == 1) ? 2.0 : 0.0;
	position = float4(uv * float2(2.0, -2.0) + float2(-1.0, 1.0), 0.0, 1.0);
}

float3 Pick(float2 uv) { return tex2D(LootDenBackBuffer, uv).rgb; }
float Luma(float3 c) { return dot(c, float3(0.2126, 0.7152, 0.0722)); }
float Hash(float2 p) { return frac(sin(dot(p, float2(12.9898, 78.233))) * 43758.5453); }

float3 SharpPS(float4 pos : SV_Position, float2 uv : TEXCOORD) : SV_Target
{
	float2 px = float2(BUFFER_RCP_WIDTH, BUFFER_RCP_HEIGHT);
	float3 c = Pick(uv);
	float3 blur = (Pick(uv + float2(px.x, 0.0)) + Pick(uv - float2(px.x, 0.0)) + Pick(uv + float2(0.0, px.y)) + Pick(uv - float2(0.0, px.y))) * 0.25;
	return saturate(c + (c - blur) * (Strength * 1.5));
}

float3 VividPS(float4 pos : SV_Position, float2 uv : TEXCOORD) : SV_Target
{
	float3 c = Pick(uv);
	float l = Luma(c);
	c = lerp(float3(l, l, l), c, 1.0 + Strength * 0.5);
	c = (c - 0.5) * (1.0 + Strength * 0.15) + 0.5;
	return saturate(c);
}

float3 FilmPS(float4 pos : SV_Position, float2 uv : TEXCOORD) : SV_Target
{
	float3 c = Pick(uv);
	float3 curve = c * c * (3.0 - 2.0 * c);
	c = lerp(c, curve, Strength * 0.35) * float3(1.04, 1.0, 0.94);
	float grain = Hash(uv * float2(BUFFER_WIDTH, BUFFER_HEIGHT) + float(Frame % 64)) - 0.5;
	return saturate(c + grain * 0.04 * Strength);
}

float3 CrtPS(float4 pos : SV_Position, float2 uv : TEXCOORD) : SV_Target
{
	float3 c = Pick(uv);
	float s = sin(uv.y * Lines * 3.14159265);
	float scan = lerp(1.0, 0.55 + 0.45 * s * s, Strength);
	float3 glow = (Pick(uv + float2(BUFFER_RCP_WIDTH * 1.5, 0.0)) + Pick(uv - float2(BUFFER_RCP_WIDTH * 1.5, 0.0))) * 0.5;
	c = lerp(c, max(c, glow), 0.5 * Strength);
	float2 d = uv - 0.5;
	float vignette = 1.0 - dot(d, d) * 0.6 * Strength;
	return saturate(c * scan * vignette * (1.0 + 0.2 * Strength));
}

technique LootDenSharp < ui_label = "LootDen: Sharp"; > { pass { VertexShader = LootDenVS; PixelShader = SharpPS; } }
technique LootDenVivid < ui_label = "LootDen: Vivid"; > { pass { VertexShader = LootDenVS; PixelShader = VividPS; } }
technique LootDenFilm < ui_label = "LootDen: Film"; > { pass { VertexShader = LootDenVS; PixelShader = FilmPS; } }
technique LootDenCRT < ui_label = "LootDen: CRT"; > { pass { VertexShader = LootDenVS; PixelShader = CrtPS; } }
`;

const TECHNIQUE: Record<Exclude<RecompLookId, "off">, string> = { sharp: "LootDenSharp", vivid: "LootDenVivid", film: "LootDenFilm", crt: "LootDenCRT" };

/** The console's own line count, so CRT scanlines line up with the picture the game was made for. */
export function crtLines(platform: string): number {
  return platform === "ps2" || platform === "gamecube" || platform === "wii" || platform === "xbox" ? 480 : platform === "x360" || platform === "ps3" ? 720 : 240;
}

const CHECK_EVERY_MS = 7 * 24 * 60 * 60 * 1000;
const reshadeDir = (toolsDir: string) => path.join(toolsDir, "reshade");

/** ReShade's setup is a program with a zip on a 512-byte boundary; the 64-bit library is inside. Returns the zip's bytes. */
export function zipInSetup(setup: Uint8Array): Uint8Array | null {
  for (let i = 0; i + 30 <= setup.length; i += 512) {
    if (setup[i] === 0x50 && setup[i + 1] === 0x4b && setup[i + 2] === 0x03 && setup[i + 3] === 0x04 && setup.subarray(i + 4, i + 30).some((b) => b !== 0)) return setup.subarray(i);
  }
  return null;
}

/**
 * ReShade's 64-bit library, downloaded from reshade.me the first time and looked at again weekly for
 * a newer version. Offline, the copy already here is used.
 */
export async function ensureReShade(toolsDir: string, sevenZip: SevenZip, fetchImpl: Fetch = fetch, emit: (m: string) => void = () => {}): Promise<string> {
  const dir = reshadeDir(toolsDir);
  const dll = path.join(dir, "ReShade64.dll");
  const have = await readFile(path.join(dir, "version.txt"), "utf8").catch(() => null);
  const checked = await stat(path.join(dir, "version.txt")).then((s) => s.mtimeMs, () => 0);
  const present = await stat(dll).then((s) => s.isFile(), () => false);
  if (present && have && Date.now() - checked < CHECK_EVERY_MS) return dll;
  let version: string | null = null;
  try {
    const res = await fetchImpl("https://api.github.com/repos/crosire/reshade/tags?per_page=5", { headers: { "User-Agent": "LootDen", Accept: "application/vnd.github+json" } });
    const tags = res.ok ? ((await res.json()) as Array<{ name: string }>) : [];
    version = tags.map((t) => /^v?(\d+\.\d+\.\d+)$/.exec(t.name)?.[1]).find(Boolean) ?? null;
  } catch {
    // Offline: keep what's here.
  }
  if (!version) {
    if (present) return dll;
    throw new Error("Couldn't find out ReShade's latest version (it's needed for looks). Check the internet connection and try again.");
  }
  if (present && have?.trim() === version) {
    const now = new Date();
    await utimes(path.join(dir, "version.txt"), now, now);
    return dll;
  }
  emit(`Downloading ReShade ${version} from reshade.me`);
  await mkdir(dir, { recursive: true });
  const tmp = await mkdtemp(path.join(os.tmpdir(), "lootden-reshade-"));
  try {
    const setup = path.join(tmp, "setup.exe");
    await download(fetchImpl, `https://reshade.me/downloads/ReShade_Setup_${version}.exe`, setup);
    const zip = zipInSetup(await readFile(setup));
    if (!zip) throw new Error("That download wasn't a ReShade setup");
    await writeFile(path.join(tmp, "setup.zip"), zip);
    await extractArchive(sevenZip, "zip", path.join(tmp, "setup.zip"), path.join(tmp, "out"));
    const found = await findFile(path.join(tmp, "out"), /^ReShade64\.dll$/i);
    const bytes = found ? await readFile(found) : null;
    if (!bytes || bytes[0] !== 0x4d || bytes[1] !== 0x5a) throw new Error("That download wasn't a ReShade setup");
    await copyFile(found!, dll);
    await writeFile(path.join(dir, "version.txt"), version);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  return dll;
}

const MARKER = ".lootden-reshade";

/**
 * Puts ReShade beside the recomp's program with the chosen look, and returns what undoes it plus the
 * environment ReShade reads its settings folder from. Leaves a dxgi.dll that isn't LootDen's alone.
 */
export async function applyLook(opts: { exe: string; dataDir: string; dll: string; look: RecompLookId; lines: number; strength?: number }): Promise<{ env: Record<string, string>; undo: () => Promise<void> }> {
  const none = { env: {}, undo: async () => {} };
  if (opts.look === "off") return none;
  const exeDir = path.dirname(opts.exe);
  const target = path.join(exeDir, "dxgi.dll");
  const ours = await stat(path.join(exeDir, MARKER)).then(() => true, () => false);
  if ((await stat(target).then(() => true, () => false)) && !ours) {
    throw new Error("There's already a dxgi.dll beside the game (another mod or ReShade), so LootDen won't add its look. Set Look to Off, or remove that file.");
  }
  const base = path.join(opts.dataDir, "reshade");
  await mkdir(path.join(base, "Shaders"), { recursive: true });
  await mkdir(path.join(base, "Textures"), { recursive: true });
  await writeFile(path.join(base, "Shaders", "LootDenLooks.fx"), LOOKS_FX);
  const technique = `${TECHNIQUE[opts.look]}@LootDenLooks.fx`;
  const strength = (opts.strength ?? 0.6).toFixed(6);
  await writeFile(
    path.join(base, "LootDen.ini"),
    [`Techniques=${technique}`, `TechniqueSorting=${technique}`, "", "[LootDenLooks.fx]", `Lines=${opts.lines.toFixed(6)}`, `Strength=${strength}`, ""].join("\r\n"),
  );
  await writeFile(
    path.join(base, "ReShade.ini"),
    [
      "[GENERAL]",
      `EffectSearchPaths=${path.join(base, "Shaders")}`,
      `TextureSearchPaths=${path.join(base, "Textures")}`,
      `PresetPath=${path.join(base, "LootDen.ini")}`,
      `IntermediateCachePath=${path.join(base, "Cache")}`,
      "PerformanceMode=1",
      "",
      "[OVERLAY]",
      // Skip ReShade's first-run tutorial; Home still opens its menu for anyone who wants it.
      "TutorialProgress=4",
      "",
    ].join("\r\n"),
  );
  await copyFile(opts.dll, target);
  await writeFile(path.join(exeDir, MARKER), "dxgi.dll was put here by LootDen for a look and is removed when the game closes.\n");
  return {
    env: { RESHADE_BASE_PATH_OVERRIDE: base },
    undo: async () => {
      await rm(target, { force: true }).catch(() => {});
      await rm(path.join(exeDir, MARKER), { force: true }).catch(() => {});
    },
  };
}
