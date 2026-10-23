import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { steam } from "../src/addons/steam.js";
import { makeApp, makeLibrary } from "./helpers.js";

let root: string;
before(async () => {
  root = await makeLibrary();
});
after(() => rm(root, { recursive: true, force: true }));

const STEAM_ID = "76561197960287930";
const keysUsed: string[] = [];
let steamSaysValid = true;
const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.href === "https://steamcommunity.com/openid/login") {
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get("openid.mode"), "check_authentication");
    return new Response(`ns:http://specs.openid.net/auth/2.0\nis_valid:${steamSaysValid}\n`);
  }
  if (url.pathname.startsWith("/IPlayerService/GetOwnedGames")) {
    keysUsed.push(url.searchParams.get("key") ?? "");
    assert.equal(url.searchParams.get("steamid"), STEAM_ID);
    return Response.json({ response: { games: [{ appid: 620, name: "Portal 2", playtime_forever: 60 }] } });
  }
  throw new Error(`Unexpected network call in test: ${url}`);
}) as typeof fetch;

async function signIn(app: Awaited<ReturnType<typeof makeApp>>["app"], ctx: Awaited<ReturnType<typeof makeApp>>["ctx"], username: string, role: "user" | "admin" = "user") {
  await ctx.users.create({ username, password: "password123", role });
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password: "password123" } });
  return { cookie: `gm_session=${login.cookies.find((c) => c.name === "gm_session")!.value}` };
}

/** What Steam sends the browser back with after someone signs in there. */
function steamAnswer(start: string, claimed = `https://steamcommunity.com/openid/id/${STEAM_ID}`): string {
  const out = new URL(start);
  const returnTo = out.searchParams.get("openid.return_to")!;
  const back = new URL(returnTo);
  for (const [k, v] of Object.entries({ ns: "http://specs.openid.net/auth/2.0", mode: "id_res", op_endpoint: "https://steamcommunity.com/openid/login", claimed_id: claimed, identity: claimed, return_to: returnTo, response_nonce: "2026-10-23T17:00:00Zabc", assoc_handle: "1234567890", signed: "signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle", sig: "xyz" }))
    back.searchParams.set(`openid.${k}`, v);
  return back.pathname + back.search;
}

describe("Sign in with Steam and a server-wide Steam key", () => {
  it("links the Steam account and syncs it with the admin's key", async () => {
    const { app, ctx } = await makeApp(root, { publicUrl: "https://games.example" }, { fetchImpl, addons: [steam], resolveHost: async () => ["93.184.216.34"] });
    const admin = await signIn(app, ctx, "admin", "admin");
    const sam = await signIn(app, ctx, "sam");

    // People can't set the shared key; the admin can, and it's never shown back.
    assert.equal((await app.inject({ method: "PUT", url: "/api/addons/steam/shared", headers: sam, payload: { config: { apiKey: "x" } } })).statusCode, 403);
    const list = (await app.inject({ method: "PUT", url: "/api/addons/steam/shared", headers: admin, payload: { config: { apiKey: "SERVERKEY" } } })).json();
    assert.deepEqual(list[0].sharedSet, ["apiKey"]);
    assert.ok(!JSON.stringify(list).includes("SERVERKEY"));
    assert.deepEqual(list[0].signIn, { label: "Sign in with Steam", start: "/api/addons/steam/signin" });

    const { url } = (await app.inject({ method: "POST", url: "/api/addons/steam/signin", headers: sam })).json();
    const start = new URL(url);
    assert.equal(start.origin + start.pathname, "https://steamcommunity.com/openid/login");
    assert.equal(start.searchParams.get("openid.realm"), "https://games.example");
    assert.match(start.searchParams.get("openid.return_to")!, /^https:\/\/games\.example\/api\/addons\/steam\/signin\/callback\?state=/);

    // The desktop app finishes in the system browser, where nobody is signed in.
    const done = await app.inject({ url: steamAnswer(url) });
    assert.equal(done.statusCode, 200);
    assert.match(done.body, /Steam account linked: 1 games/);
    assert.deepEqual(keysUsed, ["SERVERKEY"]);
    const games = (await app.inject({ url: "/api/store-games", headers: sam })).json();
    assert.equal(games[0].title, "Portal 2");
    const card = (await app.inject({ url: "/api/addons", headers: sam })).json()[0];
    assert.equal(card.account.config.steamId, STEAM_ID);
    assert.equal(card.account.config.apiKey, "", "the server's key isn't the person's");

    // Their own key wins over the server's.
    await app.inject({ method: "PUT", url: "/api/addons/steam/account", headers: sam, payload: { config: { steamId: STEAM_ID, apiKey: "MINE" } } });
    assert.equal(keysUsed.at(-1), "MINE");

    // In a signed-in browser it goes straight back to the profile.
    const again = (await app.inject({ method: "POST", url: "/api/addons/steam/signin", headers: sam })).json().url;
    const back = await app.inject({ url: steamAnswer(again), headers: sam });
    assert.equal(back.statusCode, 302);
    assert.match(back.headers.location as string, /^\/profile\?steam=/);
  });

  it("refuses answers Steam doesn't confirm, replays and other sign-ins", async () => {
    const { app, ctx } = await makeApp(root, { publicUrl: "https://games.example" }, { fetchImpl, addons: [steam], resolveHost: async () => ["93.184.216.34"] });
    const sam = await signIn(app, ctx, "sam");
    const start = async () => (await app.inject({ method: "POST", url: "/api/addons/steam/signin", headers: sam })).json().url as string;

    steamSaysValid = false;
    assert.match((await app.inject({ url: steamAnswer(await start()) })).body, /couldn&#39;t confirm/);
    steamSaysValid = true;

    const used = steamAnswer(await start());
    assert.match((await app.inject({ url: used })).body, /Steam account linked/);
    assert.match((await app.inject({ url: used })).body, /expired or was already used/);

    const forged = new URL(`https://x${steamAnswer(await start())}`);
    forged.searchParams.set("openid.return_to", "https://evil.example/cb");
    assert.match((await app.inject({ url: forged.pathname + forged.search })).body, /different sign-in/);
    assert.match((await app.inject({ url: steamAnswer(await start(), "https://evil.example/openid/id/1") })).body, /didn&#39;t say which account/);

    // Without a key anywhere the account is still linked, and the person is told what's missing.
    const noKey = await app.inject({ url: steamAnswer(await start()) });
    assert.match(noKey.body, /Steam account linked/);
  });
});
