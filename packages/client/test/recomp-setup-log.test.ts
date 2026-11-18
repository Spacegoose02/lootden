import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { runPrepare } from "../src/recomps.js";

let dir: string;
before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "gm-recomp-setup-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("a recomp's setup step", () => {
  it("keeps everything it printed and names its last line when it fails", async () => {
    const script = path.join(dir, "setup.js");
    await writeFile(script, 'console.log("progress 0.5 Unpacking");\nconsole.log("Keys not found next to the game");\nprocess.exit(1);\n');
    const log = path.join(dir, "lootden-setup.log");
    const seen: string[] = [];
    await assert.rejects(
      runPrepare(process.execPath, [script, "C:\\Games\\My Game.nsp"], dir, 30, {}, (_f, t) => seen.push(t), log),
      (e: Error) => e.message.includes("exit code 1: Keys not found next to the game") && e.message.includes(log),
    );
    assert.deepEqual(seen, ["Unpacking"]);
    const text = await readFile(log, "utf8");
    assert.match(text, /"C:\\\\Games\\\\My Game\.nsp"/);
    assert.match(text, /Keys not found/);
    assert.match(text, /exit code 1/);
  });

  it("prefers what it wrote to stderr, and says when it gave no reason", async () => {
    const loud = path.join(dir, "loud.js");
    await writeFile(loud, 'console.log("working");\nconsole.error("bad dump");\nprocess.exit(2);\n');
    await assert.rejects(runPrepare(process.execPath, [loud], dir, 30, {}, () => {}), /exit code 2: bad dump\.$/);
    const quiet = path.join(dir, "quiet.js");
    await writeFile(quiet, "process.exit(1);\n");
    await assert.rejects(runPrepare(process.execPath, [quiet], dir, 30, {}, () => {}), /exit code 1 without saying why/);
  });

  it("writes the log when it works too", async () => {
    const ok = path.join(dir, "ok.js");
    await writeFile(ok, 'console.log("done");\n');
    const log = path.join(dir, "ok.log");
    await runPrepare(process.execPath, [ok], dir, 30, {}, () => {}, log);
    assert.match(await readFile(log, "utf8"), /done[\s\S]*exit code 0/);
  });
});
