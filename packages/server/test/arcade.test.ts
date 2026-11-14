import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { ArcadeLobby } from "@lootden/shared";
import { makeApp, makeLibrary, sessionCookie } from "./helpers.js";

let root: string;
before(async () => {
  root = await makeLibrary();
  await mkdir(path.join(root, "Emulation", "arcade", "Daytona3.teknoparrot"), { recursive: true });
  await writeFile(path.join(root, "Emulation", "arcade", "Daytona3.teknoparrot", "Daytona.exe"), "exe");
  await mkdir(path.join(root, "Emulation", "TeknoParrot", "Outrun 2 SP SDX"), { recursive: true });
  await writeFile(path.join(root, "Emulation", "TeknoParrot", "Outrun 2 SP SDX", "game.exe"), "exe");
});
after(() => rm(root, { recursive: true, force: true }));

type App = Awaited<ReturnType<typeof makeApp>>;

async function person(app: App["app"], ctx: App["ctx"], username: string) {
  await ctx.users.create({ username, password: "password123", displayName: username[0]!.toUpperCase() + username.slice(1) });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: "password123" } });
  return { cookie: sessionCookie(login) };
}

describe("arcade games", () => {
  it("are their own system, named after the game rather than the TeknoParrot profile", async () => {
    const { ctx } = await makeApp(root);
    const arcade = ctx.library.list({}).filter((g) => g.platform === "arcade");
    assert.deepEqual(arcade.map((g) => g.title).sort(), ["Daytona Championship USA", "Outrun 2 SP SDX"]);
  });

  it("gather PCs for a linked race, numbering cabinets in the order they join", async () => {
    const { app, ctx } = await makeApp(root);
    const dad = await person(app, ctx, "dad");
    const kid = await person(app, ctx, "kid");
    const daytona = ctx.library.list({}).find((g) => g.title === "Daytona Championship USA")!;
    const url = `/api/arcade/link/${daytona.id}`;

    const empty = (await app.inject({ url, headers: dad })).json() as ArcadeLobby;
    assert.deepEqual(empty.members, []);
    assert.equal(empty.profile, "Daytona3");
    assert.equal(empty.maxCabinets, 8);

    await app.inject({ method: "POST", url: `${url}/join`, headers: dad, payload: { device: "DEN-PC", address: "192.168.1.20" } });
    const both = (await app.inject({ method: "POST", url: `${url}/join`, headers: kid, payload: { device: "KID-PC", address: "not an ip; rm -rf" } })).json() as ArcadeLobby;
    assert.deepEqual(
      both.members.map((m) => [m.cabinet, m.device, m.name, m.address]),
      [
        [1, "DEN-PC", "Dad", "192.168.1.20"],
        [2, "KID-PC", "Kid", null],
      ],
    );

    // Joining again keeps the cabinet number; leaving moves the next PC up.
    const again = (await app.inject({ method: "POST", url: `${url}/join`, headers: dad, payload: { device: "den-pc" } })).json() as ArcadeLobby;
    assert.equal(again.members.length, 2);
    assert.equal(again.members[0]!.address, "192.168.1.20");
    const left = (await app.inject({ method: "POST", url: `${url}/leave`, headers: dad, payload: { device: "DEN-PC" } })).json() as ArcadeLobby;
    assert.deepEqual(left.members.map((m) => [m.cabinet, m.device]), [[1, "KID-PC"]]);

    assert.equal((await app.inject({ method: "POST", url: `${url}/join`, headers: kid, payload: {} })).statusCode, 400);
    const pc = ctx.library.list({}).find((g) => g.platform === "pc")!;
    assert.equal((await app.inject({ url: `/api/arcade/link/${pc.id}`, headers: kid })).statusCode, 400);
    assert.equal((await app.inject({ url, headers: {} })).statusCode, 401);
  });
});
