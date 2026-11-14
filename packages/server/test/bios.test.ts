import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { biosRequirementFor } from "@lootden/shared";
import { openDatabase } from "../src/db/database.js";
import { BiosStore } from "../src/emulation/bios.js";

let work: string;
before(async () => {
  work = await mkdtemp(path.join(os.tmpdir(), "gm-bios-"));
});
after(async () => {
  await rm(work, { recursive: true, force: true });
});

describe("BIOS files", () => {
  it("tells PS1, PS2 and Xbox BIOS names apart", () => {
    const emu = (name: string) => biosRequirementFor(name)?.emulator.id;
    for (const n of ["scph5501.bin", "SCPH1001.BIN", "scph-7502.bin", "scph101.bin", "psxonpsp660.bin"]) assert.equal(emu(n), "duckstation", n);
    for (const n of ["scph39001.bin", "SCPH-70012.bin", "SCPH-30004R.bin", "scph10000.bin", "SCPH-70012_BIOS_V12_USA_200.BIN", "ps2-0230a-20080220.bin"]) assert.equal(emu(n), "pcsx2", n);
    for (const n of ["xbox_bios.bin", "Complex_4627.bin", "mcpx_1.0.bin"]) assert.equal(emu(n), "xemu", n);
    assert.equal(emu("PS3UPDAT.PUP"), "rpcs3");
  });

  it("refiles files an older version put under the wrong emulator", () => {
    const db = openDatabase(":memory:");
    const row = db.prepare("INSERT INTO bios_files (name, emulator, size, sha1, uploaded_at) VALUES (?, ?, 1, 'x', '2026-01-01')");
    row.run("scph39001.bin", "duckstation");
    row.run("xbox_bios.bin", "pcsx2");
    row.run("scph5501.bin", "duckstation");
    const store = new BiosStore(db, work);
    assert.deepEqual(
      store.list().map((f) => [f.name, f.emulator]),
      [
        ["scph5501.bin", "duckstation"],
        ["scph39001.bin", "pcsx2"],
        ["xbox_bios.bin", "xemu"],
      ],
    );
  });
});
