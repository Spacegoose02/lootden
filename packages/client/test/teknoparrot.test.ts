import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { readArcadeState, type RunText } from "../src/arcade.js";
import type { SevenZip } from "../src/extractor.js";
import {
  installTeknoParrot,
  installTeknoParrotPrerequisites,
  managedTeknoParrot,
  partFolder,
  partVersion,
  prerequisiteScript,
  TEKNOPARROT_COMPONENTS,
  teknoParrotHome,
  teknoParrotParts,
  teknoParrotPrerequisites,
  type Prerequisite,
} from "../src/teknoparrot.js";

const sevenZip: SevenZip = { path: "/nonexistent/7za", supportsRar: false };

/** TeknoParrot's update service as it answers, with the given part versions. */
function service(versions: Record<string, string>, nested = false) {
  return Object.entries(versions).map(([component, v]) => {
    const assets = [{ name: `${component}.zip`, browser_download_url: `https://github.com/teknogods/X/releases/download/${component}/${component}.zip` }];
    const release = { tag_name: component, name: `${component}_${v}` };
    return nested ? { component, release: { ...release, assets } } : { component, release, assets };
  });
}

function fakeFetch(versions: () => Record<string, string>) {
  const downloads: string[] = [];
  const fetchImpl = (async (url: string) => {
    if (String(url) === TEKNOPARROT_COMPONENTS) return new Response(JSON.stringify(service(versions())));
    if (String(url).startsWith("https://github.com/")) {
      downloads.push(path.basename(String(url)));
      return new Response("zip");
    }
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, downloads };
}

/** "Unpacks" a part: the UI zip gets TeknoParrot's program and a profile, the rest a marker file. */
const unzip = async (zip: string, dir: string) => {
  if (/TeknoParrotUI\.zip$/i.test(zip)) {
    await writeFile(path.join(dir, "TeknoParrotUi.exe"), "exe");
    await mkdir(path.join(dir, "GameProfiles"), { recursive: true });
    await writeFile(path.join(dir, "GameProfiles", "Daytona3.xml"), "<GameProfile/>");
  } else await writeFile(path.join(dir, `${path.basename(zip).replace(/^\d+-/, "")}.unpacked`), "");
};

describe("TeknoParrot setup", () => {
  let work: string;
  before(async () => {
    work = await mkdtemp(path.join(os.tmpdir(), "lootden-tp-"));
  });
  after(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it("reads part versions and folders the way TeknoParrot's installer does", () => {
    assert.equal(partVersion("TeknoParrotUI", "TeknoParrotUI_1.0.0.2305", "TeknoParrotUi"), "1.0.0.2305");
    assert.equal(partVersion("OpenParrotx64", undefined, "OpenParrotx64", "OpenParrotx64.zip"), "OpenParrotx64");
    assert.equal(partVersion("TeknoS11", "TeknoS11 v0.1.0.0"), "0.1.0.0");
    assert.equal(partFolder("TeknoParrotUI"), "");
    assert.equal(partFolder("OpenSegaAPI"), "TeknoParrot");
    assert.equal(partFolder("TeknoParrotN2"), "N2");
    assert.equal(partFolder("OpenParrotWin32"), "OpenParrotWin32");
    assert.equal(partFolder("TeknoViper"), "TeknoViper");
  });

  it("lists parts from either answer shape and leaves out the big stand-alone emulators", async () => {
    for (const nested of [false, true]) {
      const body = service({ TeknoParrotUI: "1.0.0.2305", OpenParrotWin32: "1.0.0.787", RPCS3: "1.0.0.5", pcsx2x6: "1.0.0.11" }, nested);
      const parts = await teknoParrotParts((async () => new Response(JSON.stringify(body))) as typeof fetch);
      assert.deepEqual(
        parts.map((p) => [p.component, p.version, p.folder]),
        [
          ["TeknoParrotUI", "1.0.0.2305", ""],
          ["OpenParrotWin32", "1.0.0.787", "OpenParrotWin32"],
        ],
      );
    }
  });

  it("refuses downloads from anywhere but GitHub", async () => {
    const body = [
      { component: "TeknoParrotUI", release: { name: "TeknoParrotUI_1.0.0.1" }, assets: [{ name: "TeknoParrotUi.zip", browser_download_url: "https://github.com/teknogods/TeknoParrot/releases/download/TeknoParrotUi/TeknoParrotUi.zip" }] },
      { component: "OpenSegaAPI", release: { name: "OpenSegaAPI_1.0.0.1" }, assets: [{ name: "OpenSegaAPI.zip", browser_download_url: "https://evil.test/OpenSegaAPI.zip" }] },
    ];
    const parts = await teknoParrotParts((async () => new Response(JSON.stringify(body))) as typeof fetch);
    assert.deepEqual(
      parts.map((p) => p.component),
      ["TeknoParrotUI"],
    );
  });

  it("installs into the tools folder, makes it this PC's TeknoParrot, and updates only changed parts", async () => {
    const toolsDir = path.join(work, "tools");
    let versions: Record<string, string> = { TeknoParrotUI: "1.0.0.2305", OpenParrotWin32: "1.0.0.787", OpenSegaAPI: "1.0.0.50", TeknoParrotElfLdr2: "1.0.0.3" };
    const f = fakeFetch(() => versions);
    const r = await installTeknoParrot({ toolsDir, sevenZip, fetchImpl: f.fetchImpl, unzip });
    const dir = teknoParrotHome(toolsDir);
    assert.equal(r.dir, dir);
    assert.equal(r.version, "1.0.0.2305");
    assert.equal(r.updated.length, 4);
    assert.ok(await stat(path.join(dir, "TeknoParrotUi.exe")));
    assert.ok(await stat(path.join(dir, "TeknoParrot", "OpenSegaAPI.zip.unpacked")));
    assert.ok(await stat(path.join(dir, "OpenParrotWin32", "OpenParrotWin32.zip.unpacked")));
    assert.equal(await readFile(path.join(dir, "ElfLdr2", ".version"), "utf8"), "1.0.0.3");
    assert.equal((await readArcadeState(toolsDir)).tpDir, dir);
    assert.equal(await managedTeknoParrot(toolsDir, dir), "1.0.0.2305");
    assert.equal(await managedTeknoParrot(toolsDir, "C:\\TeknoParrot"), null);

    // The player's own profile stays through an update.
    await mkdir(path.join(dir, "UserProfiles"), { recursive: true });
    await writeFile(path.join(dir, "UserProfiles", "Daytona3.xml"), "mine");
    versions = { ...versions, OpenSegaAPI: "1.0.0.51" };
    f.downloads.length = 0;
    const again = await installTeknoParrot({ toolsDir, sevenZip, fetchImpl: f.fetchImpl, unzip });
    assert.deepEqual(again.updated, ["OpenSegaAPI"]);
    assert.deepEqual(f.downloads, ["OpenSegaAPI.zip"]);
    assert.equal(await readFile(path.join(dir, "UserProfiles", "Daytona3.xml"), "utf8"), "mine");

    const none = await installTeknoParrot({ toolsDir, sevenZip, fetchImpl: f.fetchImpl, unzip });
    assert.deepEqual(none.updated, []);
  });

  it("says so when the download has no TeknoParrot program", async () => {
    const toolsDir = path.join(work, "empty");
    const f = fakeFetch(() => ({ TeknoParrotUI: "1.0.0.1" }));
    await assert.rejects(installTeknoParrot({ toolsDir, sevenZip, fetchImpl: f.fetchImpl, unzip: async () => {} }), /program wasn't in the download/);
  });
});

describe("TeknoParrot's runtimes", () => {
  const regOut: Record<string, string> = {
    "HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64": "\r\n    Installed    REG_DWORD    0x1\r\n    Version    REG_SZ    v14.40.33810.00\r\n",
    "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x86": "",
    "HKLM\\SOFTWARE\\Microsoft\\NET Framework Setup\\NDP\\v4\\Full": "    Release    REG_DWORD    0x82348\r\n",
  };
  const run: RunText = async (_cmd, args) => regOut[args[1]!] ?? "";
  const env = { WINDIR: "C:\\Windows" } as NodeJS.ProcessEnv;

  it("checks the Visual C++ runtimes, .NET 4.8 and the DirectX June 2010 files", async () => {
    const files = new Set(["C:\\Windows\\System32\\d3dx9_43.dll", "C:\\Windows\\System32\\xinput1_3.dll", "C:\\Windows\\SysWOW64"]);
    const list = await teknoParrotPrerequisites(run, env, async (f) => files.has(f));
    const byId = Object.fromEntries(list.map((p) => [p.id, p.installed]));
    // 0x82348 = 533320, .NET 4.8.1. The 32-bit DirectX files are missing.
    assert.deepEqual(byId, { "vc-x64": true, "vc-x86": false, directx: false, dotnet48: true });
    files.add("C:\\Windows\\SysWOW64\\d3dx9_43.dll").add("C:\\Windows\\SysWOW64\\xinput1_3.dll");
    assert.equal((await teknoParrotPrerequisites(run, env, async (f) => files.has(f))).find((p) => p.id === "directx")!.installed, true);
  });

  it("writes one quiet setup script for just the missing ones", () => {
    const script = prerequisiteScript(["vc-x86", "directx"], "C:\\T");
    assert.match(script, /"C:\\T\\vc_redist\.x86\.exe" \/install \/quiet \/norestart/);
    assert.match(script, /directx_Jun2010_redist\.exe" \/Q \/T:"C:\\T\\dx"/);
    assert.match(script, /"C:\\T\\dx\\DXSETUP\.exe" \/silent/);
    assert.doesNotMatch(script, /vc_redist\.x64|ndp48/);
  });

  it("downloads the missing runtimes from Microsoft and runs them with one permission prompt", async () => {
    const toolsDir = await mkdtemp(path.join(os.tmpdir(), "lootden-tprt-"));
    try {
      let state: Prerequisite[] = [
        { id: "vc-x64", name: "VC x64", installed: true },
        { id: "vc-x86", name: "VC x86", installed: false },
        { id: "directx", name: "DirectX", installed: false },
        { id: "dotnet48", name: ".NET", installed: true },
      ];
      const urls: string[] = [];
      const fetchImpl = (async (url: string) => {
        urls.push(String(url));
        return new Response("exe");
      }) as typeof fetch;
      const scripts: string[] = [];
      const after = await installTeknoParrotPrerequisites({
        toolsDir,
        fetchImpl,
        check: async () => state,
        elevated: async (script) => {
          scripts.push(await readFile(script, "utf8"));
          state = state.map((p) => ({ ...p, installed: true }));
        },
      });
      assert.deepEqual(urls, ["https://aka.ms/vs/17/release/vc_redist.x86.exe", "https://download.microsoft.com/download/8/4/A/84A35BF1-DAFE-4AE8-82AF-AD2AE20B6B14/directx_Jun2010_redist.exe"]);
      assert.equal(scripts.length, 1);
      assert.ok(after.every((p) => p.installed));

      // Nothing missing: nothing downloaded, no prompt.
      urls.length = 0;
      await installTeknoParrotPrerequisites({ toolsDir, fetchImpl, check: async () => state, elevated: async () => assert.fail("no prompt expected") });
      assert.equal(urls.length, 0);
    } finally {
      await rm(toolsDir, { recursive: true, force: true });
    }
  });
});
