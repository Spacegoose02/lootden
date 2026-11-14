import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { arcadeProfileFor, pickBindingSet, platformFor, romTitle, type ArcadeBindingSet } from "@lootden/shared";
import {
  applyButtons,
  applyLink,
  ArcadeSetupNeeded,
  boundDevices,
  captureBindings,
  guidFromRegBinary,
  parseDirectInputGuids,
  parseOemNames,
  parsePresentDevices,
  prepareArcade,
  profileButtons,
  profileFields,
  readArcadeState,
  setProfileField,
  setXmlText,
  writeArcadeState,
  xmlText,
  type RunText,
} from "../src/arcade.js";

const WHEEL = "a1b2c3d4-0000-11ee-8001-444553540000";
const SHIFTER = "b2c3d4e5-0000-11ee-8001-444553540000";

/** One input as TeknoParrot's XmlSerializer writes it. */
function entry(name: string, mapping: string, guid?: string, button = 0, axis = false) {
  const di = guid
    ? `<DirectInputButton>
        <Button>${button}</Button>
        <IsAxis>${axis}</IsAxis>
        <IsAxisMinus>false</IsAxisMinus>
        <IsFullAxis>${axis}</IsFullAxis>
        <PovDirection>0</PovDirection>
        <IsReverseAxis>false</IsReverseAxis>
        <JoystickGuid>${guid}</JoystickGuid>
      </DirectInputButton>`
    : "";
  return `<JoystickButtons>
      <ButtonName>${name}</ButtonName>
      ${di}
      <InputMapping>${mapping}</InputMapping>
      <AnalogType>None</AnalogType>
      <BindNameDi>${guid ? `Logitech G29 Driving Force Racing Wheel USB Buttons ${button}` : ""}</BindNameDi>
      <BindName />
    </JoystickButtons>`;
}

function profileXml(entries: string[], extraFields = "") {
  return `<?xml version="1.0" encoding="utf-8"?>
<GameProfile xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <GameName>Daytona Championship USA</GameName>
  <GamePath />
  <TestMenuParameter />
  <ConfigValues>
    <FieldInformation>
      <CategoryName>General</CategoryName>
      <FieldName>Windowed</FieldName>
      <FieldValue>0</FieldValue>
      <FieldType>Bool</FieldType>
    </FieldInformation>
    <FieldInformation>
      <CategoryName>General</CategoryName>
      <FieldName>Input API</FieldName>
      <FieldValue>DirectInput</FieldValue>
      <FieldType>Dropdown</FieldType>
      <FieldOptions>
        <string>DirectInput</string>
        <string>XInput</string>
        <string>RawInput</string>
      </FieldOptions>
    </FieldInformation>${extraFields}
  </ConfigValues>
  <JoystickButtons>
    ${entries.join("\n    ")}
  </JoystickButtons>
  <EmulationProfile>Daytona3</EmulationProfile>
  <GameProfileRevision>3</GameProfileRevision>
</GameProfile>
`;
}

const unbound = () => profileXml([entry("Wheel Axis", "Analog0"), entry("Gas", "Analog2"), entry("Shift Up", "P1Button5"), entry("Gear 1", "P1Button1")]);
const wheelBound = () =>
  profileXml([entry("Wheel Axis", "Analog0", WHEEL, 0, true), entry("Gas", "Analog2", WHEEL, 4, true), entry("Shift Up", "P1Button5", WHEEL, 52), entry("Gear 1", "P1Button1", SHIFTER, 48)]);

// What `reg query ... /s /v GUID` and `/v OEMName` print on Windows.
const REG_GUIDS = `
HKEY_CURRENT_USER\\System\\CurrentControlSet\\Control\\MediaProperties\\PrivateProperties\\DirectInput\\VID_046D&PID_C24F\\Calibration\\0
    GUID    REG_BINARY    D4C3B2A10000EE118001444553540000

HKEY_CURRENT_USER\\System\\CurrentControlSet\\Control\\MediaProperties\\PrivateProperties\\DirectInput\\VID_046D&PID_C262\\Calibration\\0
    GUID    REG_BINARY    E5D4C3B20000EE118001444553540000

End of search: 2 match(es) found.
`;
const REG_NAMES = `
HKEY_CURRENT_USER\\System\\CurrentControlSet\\Control\\MediaProperties\\PrivateProperties\\Joystick\\OEM\\VID_046D&PID_C24F
    OEMName    REG_SZ    Logitech G29 Driving Force Racing Wheel

HKEY_CURRENT_USER\\System\\CurrentControlSet\\Control\\MediaProperties\\PrivateProperties\\Joystick\\OEM\\VID_046D&PID_C262
    OEMName    REG_SZ    Logitech Driving Force Shifter
`;

/** Answers reg and PowerShell like a PC with the given USB devices plugged in. */
function fakeWindows(plugged: string[]): RunText {
  return async (cmd, args) => {
    if (cmd === "reg") return args.includes("OEMName") ? REG_NAMES : REG_GUIDS;
    if (/powershell/i.test(cmd)) {
      const rows = plugged.map((v) => ({ Name: "HID-compliant game controller", DeviceID: `HID\\VID_${v.slice(0, 4)}&PID_${v.slice(5)}\\7&1234&0&0000` }));
      return JSON.stringify(rows.length === 1 ? rows[0] : rows);
    }
    return "";
  };
}

describe("TeknoParrot profiles", () => {
  it("reads and sets settings by name, keeping everything else", () => {
    const xml = unbound();
    assert.deepEqual(
      profileFields(xml).map((f) => [f.name, f.value]),
      [
        ["Windowed", "0"],
        ["Input API", "DirectInput"],
      ],
    );
    assert.deepEqual(profileFields(xml)[1]!.options, ["DirectInput", "XInput", "RawInput"]);
    const r = setProfileField(xml, "Input API", "XInput");
    assert.equal(r.set, true);
    assert.equal(profileFields(r.xml)[1]!.value, "XInput");
    assert.equal(setProfileField(xml, "Nope", "1").set, false);
    assert.equal(r.xml.replace("XInput</FieldValue>", "DirectInput</FieldValue>"), xml, "only that value changed");
  });

  it("sets the game path, escaping it, whether the element is empty or filled", () => {
    const once = setXmlText(unbound(), "GamePath", "D:\\Arcade\\Daytona & co\\Daytona.exe");
    assert.match(once, /<GamePath>D:\\Arcade\\Daytona &amp; co\\Daytona\.exe<\/GamePath>/);
    assert.equal(xmlText(once, "GamePath"), "D:\\Arcade\\Daytona & co\\Daytona.exe");
    const twice = setXmlText(once, "GamePath", "E:\\Daytona.exe");
    assert.equal(xmlText(twice, "GamePath"), "E:\\Daytona.exe");
    assert.equal(twice.match(/<GamePath>/g)!.length, 1);
  });

  it("swaps bound inputs into a fresh profile by their InputMapping", () => {
    const saved = profileButtons(wheelBound());
    assert.deepEqual(Object.keys(saved), ["Analog0", "Analog2", "P1Button5", "P1Button1"]);
    const { xml, applied } = applyButtons(unbound(), { Analog0: saved.Analog0!, P1Button1: saved.P1Button1! });
    assert.equal(applied, 2);
    const after = profileButtons(xml);
    assert.match(after.Analog0!, new RegExp(WHEEL));
    assert.match(after.P1Button1!, new RegExp(SHIFTER));
    assert.doesNotMatch(after.Analog2!, /JoystickGuid/, "inputs not in the setup stay as they were");
    assert.match(xml, /<EmulationProfile>Daytona3<\/EmulationProfile>/);
  });

  it("lists the devices the inputs use, without the keyboard", () => {
    const buttons = profileButtons(wheelBound());
    buttons.Extra = entry("Coin", "Coin1", "6f1d2b61-d5a0-11cf-bfc7-444553540000", 6);
    assert.deepEqual(
      boundDevices(buttons).guids.map((g) => g.guid),
      [WHEEL, SHIFTER],
    );
  });
});

describe("Windows input devices", () => {
  it("turns DirectInput's binary GUIDs into TeknoParrot's GUID text", () => {
    assert.equal(guidFromRegBinary("D4C3B2A10000EE118001444553540000"), WHEEL);
    assert.equal(guidFromRegBinary("nonsense"), null);
    assert.deepEqual([...parseDirectInputGuids(REG_GUIDS)], [
      [WHEEL, "046D:C24F"],
      [SHIFTER, "046D:C262"],
    ]);
    assert.equal(parseOemNames(REG_NAMES).get("046D:C262"), "Logitech Driving Force Shifter");
  });

  it("reads what's plugged in, single device or many, and spots XInput pads", () => {
    assert.deepEqual(parsePresentDevices(JSON.stringify({ Name: "x", DeviceID: "HID\\VID_046D&PID_C24F\\1" })), { vidPids: ["046D:C24F"], xinput: false });
    assert.deepEqual(parsePresentDevices(JSON.stringify([{ Name: "XINPUT compatible HID device", DeviceID: "HID\\VID_045E&PID_02FF&IG_00\\1" }])), { vidPids: ["045E:02FF"], xinput: true });
    assert.deepEqual(parsePresentDevices(""), { vidPids: [], xinput: false });
  });
});

describe("choosing a controller setup", () => {
  const set = (id: string, devices: Array<[string, string | null]>, savedAt = "2026-01-01T00:00:00Z"): ArcadeBindingSet => ({
    id,
    profile: "Daytona3",
    name: id,
    devices: devices.map(([guid, vidPid]) => ({ guid, vidPid, name: id })),
    inputApi: null,
    buttons: {},
    savedAt,
  });
  const g29 = set("g29", [[WHEEL, "046D:C24F"]]);
  const g29Shifter = set("g29+shifter", [
    [WHEEL, "046D:C24F"],
    [SHIFTER, "046D:C262"],
  ]);
  const t300 = set("t300", [["c0ffee00-0000-0000-0000-000000000000", "044F:B66E"]]);
  const pad = set("pad", [["xinput", null]]);
  const all = [g29, g29Shifter, t300, pad];

  it("uses the setup with the most of what's plugged in", () => {
    assert.equal(pickBindingSet(all, "Daytona3", { vidPids: ["046D:C24F", "046D:C262"], xinput: true })!.id, "g29+shifter");
    assert.equal(pickBindingSet(all, "Daytona3", { vidPids: ["046D:C24F"], xinput: true })!.id, "g29");
    assert.equal(pickBindingSet(all, "daytona3", { vidPids: ["044F:B66E"], xinput: false })!.id, "t300");
    assert.equal(pickBindingSet(all, "Daytona3", { vidPids: [], xinput: true })!.id, "pad");
    assert.equal(pickBindingSet(all, "Daytona3", { vidPids: [], xinput: false }), null);
    assert.equal(pickBindingSet(all, "WMMT5", { vidPids: ["046D:C24F"], xinput: true }), null, "setups are per game");
  });

  it("keeps a pinned setup while its devices are there", () => {
    const plugged = { vidPids: ["046D:C24F", "046D:C262"], xinput: true };
    assert.equal(pickBindingSet(all, "Daytona3", plugged, "pad")!.id, "pad");
    assert.equal(pickBindingSet(all, "Daytona3", plugged, "t300")!.id, "g29+shifter", "a pinned wheel that's unplugged doesn't win");
  });
});

describe("linked races", () => {
  it("fills in the link settings a game's profile has, and leaves the rest", () => {
    const fields = `
    <FieldInformation>
      <CategoryName>Network</CategoryName>
      <FieldName>Network Adapter IP</FieldName>
      <FieldValue>127.0.0.1</FieldValue>
      <FieldType>Text</FieldType>
    </FieldInformation>
    <FieldInformation>
      <CategoryName>Network</CategoryName>
      <FieldName>Cabinet ID</FieldName>
      <FieldValue>1</FieldValue>
      <FieldType>Dropdown</FieldType>
      <FieldOptions><string>1</string><string>2</string></FieldOptions>
    </FieldInformation>`;
    const r = applyLink(profileXml([], fields), { cabinet: 2, total: 2, address: "192.168.1.21" });
    assert.deepEqual(r.set, ["Network Adapter IP = 192.168.1.21", "Cabinet ID = 2"]);
    assert.equal(profileFields(r.xml).find((f) => f.name === "Windowed")!.value, "0");
    // A cabinet number the game's list doesn't offer isn't written.
    assert.deepEqual(applyLink(profileXml([], fields), { cabinet: 3, total: 3, address: null }).set, []);
    assert.deepEqual(applyLink(unbound(), { cabinet: 1, total: 2, address: "10.0.0.2" }).set, [], "Daytona's own cabinet ID lives in its test menu");
  });
});

describe("arcade games in the library", () => {
  it("is a system of its own, found by its folder names", () => {
    assert.equal(platformFor("arcade").runner, "teknoparrot");
    assert.equal(platformFor("TeknoParrot").id, "arcade");
    assert.equal(platformFor("arcade").emulator, null, "nothing to download: TeknoParrot is the player's own");
  });

  it("knows Daytona's profile from its folder or title", () => {
    assert.equal(arcadeProfileFor("Daytona Championship USA", "Daytona Championship USA"), "Daytona3");
    assert.equal(arcadeProfileFor("Daytona USA 3 NSE", "Daytona USA 3 NSE"), "Daytona3NSE");
    assert.equal(arcadeProfileFor("D:/Games/Emulation/arcade/WMMT5.teknoparrot", "WMMT5"), "WMMT5");
    assert.equal(arcadeProfileFor("Wangan", "Wangan Midnight", ["WMMT5"]), null);
    assert.equal(arcadeProfileFor("wmmt5", "wmmt5", ["WMMT5", "Daytona3"]), "WMMT5", "a folder named after a profile, in any case");
    assert.equal(arcadeProfileFor("Daytona Championship USA", "", ["Daytona3NSE"]), null, "only profiles TeknoParrot has");
    assert.equal(romTitle("Daytona3.teknoparrot"), "Daytona3");
  });
});

describe("starting an arcade game", () => {
  let root: string;
  let tpDir: string;
  let toolsDir: string;
  let gameDir: string;
  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "lootden-arcade-"));
    tpDir = path.join(root, "TeknoParrot");
    toolsDir = path.join(root, "tools");
    gameDir = path.join(root, "games", "Daytona Championship USA");
    await mkdir(path.join(tpDir, "GameProfiles"), { recursive: true });
    await writeFile(path.join(tpDir, "TeknoParrotUi.exe"), "exe");
    await writeFile(path.join(tpDir, "GameProfiles", "Daytona3.xml"), unbound());
    await mkdir(path.join(gameDir, "Tools"), { recursive: true });
    await writeFile(path.join(gameDir, "Daytona.exe"), "x".repeat(5000));
    await writeFile(path.join(gameDir, "Tools", "amdaemon.exe"), "x".repeat(9000));
    await writeArcadeState(toolsDir, { tpDir, games: {}, bindings: [] });
  });
  after(() => rm(root, { recursive: true, force: true }));

  it("asks for TeknoParrot, and works on Windows only", async () => {
    const empty = path.join(root, "empty-tools");
    await assert.rejects(prepareArcade("g1", gameDir, "Daytona Championship USA", { toolsDir: empty, platform: "win32", run: fakeWindows([]) }), (e) => e instanceof ArcadeSetupNeeded && e.need === "teknoparrot");
    await assert.rejects(prepareArcade("g1", gameDir, "Daytona Championship USA", { toolsDir, platform: "linux" }), /Windows only/);
  });

  it("makes the player's profile from the template and starts straight into it", async () => {
    const plan = await prepareArcade("g1", gameDir, "Daytona Championship USA", { toolsDir, platform: "win32", run: fakeWindows([]) });
    assert.equal(plan.profile, "Daytona3");
    assert.deepEqual(plan.args, ["--profile=Daytona3.xml"]);
    assert.equal(plan.exe, path.join(tpDir, "TeknoParrotUi.exe"));
    assert.equal(plan.gameExe, "Daytona.exe", "not the cabinet's own services");
    assert.equal(plan.bindings, null);
    const user = await readFile(path.join(tpDir, "UserProfiles", "Daytona3.xml"), "utf8");
    assert.equal(xmlText(user, "GamePath"), path.join(gameDir, "Daytona.exe"));
    assert.equal(await readFile(path.join(tpDir, "GameProfiles", "Daytona3.xml"), "utf8"), unbound(), "the template is left alone");
  });

  it("saves the controls bound in TeknoParrot for the devices they use, and puts them back when those are plugged in", async () => {
    // The player binds the wheel and shifter in TeknoParrot's own window.
    await writeFile(path.join(tpDir, "UserProfiles", "Daytona3.xml"), setXmlText(wheelBound(), "GamePath", path.join(gameDir, "Daytona.exe")));
    const set = await captureBindings(toolsDir, tpDir, "Daytona3", undefined, fakeWindows([]));
    assert.equal(set.name, "Logitech G29 Driving Force Racing Wheel + Logitech Driving Force Shifter");
    assert.deepEqual(
      set.devices.map((d) => d.vidPid),
      ["046D:C24F", "046D:C262"],
    );
    assert.equal(set.inputApi, "DirectInput");
    // Saving again for the same devices replaces the setup rather than adding one.
    await captureBindings(toolsDir, tpDir, "Daytona3", "G29 + shifter", fakeWindows([]));
    const state = await readArcadeState(toolsDir);
    assert.equal(state.bindings.length, 1);
    assert.equal(state.bindings[0]!.name, "G29 + shifter");

    // TeknoParrot (or another front end) resets the controls; the next start with both plugged in brings them back.
    await writeFile(path.join(tpDir, "UserProfiles", "Daytona3.xml"), unbound());
    const plan = await prepareArcade("g1", gameDir, "Daytona Championship USA", { toolsDir, platform: "win32", run: fakeWindows(["046D:C24F", "046D:C262"]), executable: "Daytona.exe" });
    assert.equal(plan.bindings?.name, "G29 + shifter");
    const user = profileButtons(await readFile(path.join(tpDir, "UserProfiles", "Daytona3.xml"), "utf8"));
    assert.match(user.Analog0!, new RegExp(WHEEL));
    assert.match(user.P1Button1!, new RegExp(SHIFTER));
    assert.ok((await readArcadeState(toolsDir)).bindings[0]!.lastUsedAt);

    // With the shifter unplugged, that setup isn't used.
    const without = await prepareArcade("g1", gameDir, "Daytona Championship USA", { toolsDir, platform: "win32", run: fakeWindows(["046D:C24F"]) });
    assert.equal(without.bindings, null);
  });

  it("uses the profile the player picked, and tells the player the test-menu steps for a race", async () => {
    await writeFile(path.join(tpDir, "GameProfiles", "Daytona3NSE.xml"), unbound());
    const state = await readArcadeState(toolsDir);
    state.games.g1 = { profile: "Daytona3NSE" };
    await writeArcadeState(toolsDir, state);
    const plan = await prepareArcade("g1", gameDir, "Daytona Championship USA", { toolsDir, platform: "win32", run: fakeWindows([]), link: { cabinet: 2, total: 2, address: "192.168.1.21" } });
    assert.deepEqual(plan.args, ["--profile=Daytona3NSE.xml"]);
    assert.match(plan.linkSteps.join(" "), /NETWORK SETTINGS.*CABINET ID/);
  });

  it("asks which program is the game when it can't tell", async () => {
    const odd = path.join(root, "games", "Mystery");
    await mkdir(odd, { recursive: true });
    await writeFile(path.join(odd, "amdaemon.exe"), "x");
    const state = await readArcadeState(toolsDir);
    state.games.g2 = { profile: "Daytona3" };
    await writeArcadeState(toolsDir, state);
    // The profile's GamePath points at Daytona.exe, which isn't in this folder.
    await assert.rejects(prepareArcade("g2", odd, "Mystery", { toolsDir, platform: "win32", run: fakeWindows([]) }), (e) => e instanceof ArcadeSetupNeeded && e.need === "executable");
  });
});
