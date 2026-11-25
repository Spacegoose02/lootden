import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { XboxLive, XboxLiveError, streamFailure, teredoClient, withTeredo, type XboxSavedSignIn } from "../src/xboxlive.js";

type Call = { url: string; method: string; headers: Record<string, string>; body: string };
type Reply = { status?: number; json?: unknown };

/** A fake fetch that answers by address; each route may answer differently on each call. */
function fakeFetch(routes: Record<string, Reply | Reply[] | ((c: Call) => Reply)>) {
  const calls: Call[] = [];
  const seen = new Map<string, number>();
  const impl = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const call: Call = { url, method: init.method ?? "GET", headers: (init.headers ?? {}) as Record<string, string>, body: String(init.body ?? "") };
    calls.push(call);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) throw new Error(`unexpected fetch ${url}`);
    const route = routes[key]!;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    const reply = typeof route === "function" ? route(call) : Array.isArray(route) ? route[Math.min(n, route.length - 1)]! : route;
    const status = reply.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(reply.json ?? {}), { status, headers: { "Content-Type": "application/json" } });
  };
  return { impl: impl as typeof fetch, calls };
}

const NOW = Date.parse("2026-11-25T12:00:00Z");
const later = new Date(NOW + 8 * 3600_000).toISOString();

const tokenChain = {
  "user.auth.xboxlive.com": { json: { Token: "user-token", NotAfter: later } },
  "xsts.auth.xboxlive.com": (c: Call) => {
    const rp = JSON.parse(c.body).RelyingParty as string;
    return { json: { Token: rp.includes("gssv") ? "gssv-xsts" : "web-xsts", NotAfter: later, DisplayClaims: { xui: [{ uhs: "uhs1", gtg: "Goose", xid: "123" }] } } };
  },
};

const signedIn: XboxSavedSignIn = { refreshToken: "refresh", accessToken: "access", accessExpiresAt: NOW + 3600_000, signedInAt: new Date(NOW).toISOString() };

describe("Xbox sign-in", () => {
  it("starts a device code sign-in", async () => {
    const f = fakeFetch({ "/devicecode": { json: { user_code: "ABCD1234", device_code: "dev", verification_uri: "https://microsoft.com/link", expires_in: 900, interval: 5 } } });
    const live = new XboxLive(null, () => {}, f.impl, () => NOW);
    const code = await live.startSignIn();
    assert.deepEqual(code, { userCode: "ABCD1234", deviceCode: "dev", verificationUri: "https://microsoft.com/link", expiresIn: 900, interval: 5 });
    assert.match(f.calls[0]!.body, /scope=xboxlive\.signin/);
  });

  it("says pending, expired and declined while the code isn't entered", async () => {
    for (const [error, code] of [["authorization_pending", "pending"], ["slow_down", "pending"], ["expired_token", "expired"], ["authorization_declined", "declined"]] as const) {
      const f = fakeFetch({ "/token": { status: 400, json: { error } } });
      const live = new XboxLive(null, () => {}, f.impl, () => NOW);
      await assert.rejects(live.finishSignIn("dev"), (e: unknown) => e instanceof XboxLiveError && e.code === code);
      assert.equal(live.signedIn, false);
    }
  });

  it("saves the sign-in and the gamertag once the code is entered", async () => {
    const saves: Array<XboxSavedSignIn | null> = [];
    const f = fakeFetch({ "/oauth2/v2.0/token": { json: { access_token: "access", refresh_token: "refresh", expires_in: 3600 } }, ...tokenChain });
    const live = new XboxLive(null, (s) => saves.push(s), f.impl, () => NOW);
    await live.finishSignIn("dev");
    assert.equal(live.signedIn, true);
    assert.equal(live.gamertag, "Goose");
    assert.equal(saves.at(-1)?.refreshToken, "refresh");
    assert.equal(saves.at(-1)?.gamertag, "Goose");
    const user = f.calls.find((c) => c.url.includes("user.auth"))!;
    assert.equal(JSON.parse(user.body).Properties.RpsTicket, "d=access");
  });

  it("explains an account with no Xbox profile", async () => {
    const f = fakeFetch({ "/oauth2/v2.0/token": { json: { access_token: "a", refresh_token: "r" } }, "user.auth.xboxlive.com": tokenChain["user.auth.xboxlive.com"], "xsts.auth.xboxlive.com": { status: 401, json: { XErr: 2148916233 } } });
    const live = new XboxLive(null, () => {}, f.impl, () => NOW);
    await assert.rejects(live.finishSignIn("dev"), (e: unknown) => e instanceof XboxLiveError && e.code === "xbox");
  });

  it("refreshes an old access token, and signs out when Microsoft revokes it", async () => {
    const old = { ...signedIn, accessExpiresAt: NOW - 1 };
    const ok = fakeFetch({ "/oauth2/v2.0/token": { json: { access_token: "fresh", refresh_token: "refresh2", expires_in: 3600 } }, ...tokenChain, "xccs.xboxlive.com": { json: { result: [] } } });
    const saves: Array<XboxSavedSignIn | null> = [];
    await new XboxLive(old, (s) => saves.push(s), ok.impl, () => NOW).consoles();
    assert.equal(saves.at(-1)?.refreshToken, "refresh2");
    assert.equal(JSON.parse(ok.calls.find((c) => c.url.includes("user.auth"))!.body).Properties.RpsTicket, "d=fresh");

    const revoked = fakeFetch({ "/oauth2/v2.0/token": { status: 400, json: { error: "invalid_grant" } } });
    const live = new XboxLive(old, () => {}, revoked.impl, () => NOW);
    await assert.rejects(live.consoles(), (e: unknown) => e instanceof XboxLiveError && e.code === "signed-out");
    assert.equal(live.signedIn, false);
  });

  it("needs a sign-in before anything else", async () => {
    const live = new XboxLive(null, () => {}, fakeFetch({}).impl, () => NOW);
    await assert.rejects(live.consoles(), (e: unknown) => e instanceof XboxLiveError && e.code === "signed-out");
  });
});

describe("Xbox consoles", () => {
  it("lists the consoles, signed with the console API's token", async () => {
    const f = fakeFetch({
      ...tokenChain,
      "/lists/devices": { json: { status: { errorCode: "OK" }, result: [{ id: "F4001A2B3C4D5E6F", name: "Living room", consoleType: "XboxSeriesX", powerState: "ConnectedStandby", consoleStreamingEnabled: true, remoteManagementEnabled: true }] } },
    });
    const consoles = await new XboxLive(signedIn, () => {}, f.impl, () => NOW).consoles();
    assert.deepEqual(consoles, [{ id: "F4001A2B3C4D5E6F", name: "Living room", consoleType: "XboxSeriesX", powerState: "ConnectedStandby", streamingEnabled: true, remoteManagementEnabled: true }]);
    const call = f.calls.find((c) => c.url.includes("/lists/devices"))!;
    assert.equal(call.headers.Authorization, "XBL3.0 x=uhs1;web-xsts");
  });

  it("keeps only games, newest played first", async () => {
    const f = fakeFetch({
      ...tokenChain,
      "/lists/installedApps": {
        json: {
          result: [
            { titleId: "1", name: "Old game", isGame: true, contentType: "Game", oneStoreProductId: "9OLD", lastActiveTime: "2026-01-01T00:00:00Z", sizeInBytes: 10 },
            { titleId: "2", name: "GTA VI", isGame: true, contentType: "Game", oneStoreProductId: "9GTA", lastActiveTime: "2026-11-20T00:00:00Z", sizeInBytes: 20 },
            { titleId: "3", name: "Netflix", isGame: false, contentType: "App" },
            { titleId: "4", name: "Expansion", isGame: true, contentType: "Dlc", parentId: "2" },
            { titleId: "0", name: "System", isGame: true, contentType: "Game" },
          ],
        },
      },
    });
    const games = await new XboxLive(signedIn, () => {}, f.impl, () => NOW).installedGames("F4001A2B3C4D5E6F");
    assert.deepEqual(games.map((g) => [g.name, g.productId]), [["GTA VI", "9GTA"], ["Old game", "9OLD"]]);
    assert.match(f.calls.at(-1)!.url, /deviceId=F4001A2B3C4D5E6F/);
  });

  it("wakes a console and starts a game on it", async () => {
    const f = fakeFetch({ ...tokenChain, "/commands": { json: { status: { errorCode: "OK" } } } });
    const live = new XboxLive(signedIn, () => {}, f.impl, () => NOW);
    await live.wake("F4001A2B3C4D5E6F");
    await live.launch("F4001A2B3C4D5E6F", "9GTA");
    const [wake, launch] = f.calls.filter((c) => c.url.endsWith("/commands")).map((c) => JSON.parse(c.body));
    assert.equal(wake.type, "Power");
    assert.equal(wake.command, "WakeUp");
    assert.equal(wake.linkedXboxId, "F4001A2B3C4D5E6F");
    assert.equal(launch.command, "ActivateApplicationWithOneStoreProductId");
    assert.deepEqual(launch.parameters, [{ oneStoreProductId: "9GTA" }]);
  });

  it("passes on the console service's own error", async () => {
    const f = fakeFetch({ ...tokenChain, "/commands": { json: { status: { errorCode: "DeviceUnavailable", errorMessage: "The console is off" } } } });
    await assert.rejects(new XboxLive(signedIn, () => {}, f.impl, () => NOW).wake("F4001A2B3C4D5E6F"), /The console is off/);
  });
});

describe("Xbox streaming", () => {
  const streaming = (extra: Record<string, Reply | Reply[] | ((c: Call) => Reply)>) =>
    fakeFetch({
      ...tokenChain,
      "/v2/login/user": { json: { gsToken: "gs", durationInSeconds: 3600, offeringSettings: { regions: [{ baseUri: "https://other.example/", isDefault: false }, { baseUri: "https://uks.example/", isDefault: true }] } } },
      "/v5/sessions/home/play": { json: { sessionPath: "v5/sessions/home/SESSION1" } },
      "oauth20_token.srf": { json: { access_token: "transfer" } },
      ...extra,
    });

  it("starts a session with the console in the default region", async () => {
    const f = streaming({});
    const s = await new XboxLive(signedIn, () => {}, f.impl, () => NOW).startStream("F4001A2B3C4D5E6F", { width: 3440, height: 1440 });
    assert.equal(s.id, "SESSION1");
    const play = f.calls.find((c) => c.url.endsWith("/play"))!;
    assert.equal(play.url, "https://uks.example/v5/sessions/home/play");
    assert.equal(play.headers.Authorization, "Bearer gs");
    assert.equal(JSON.parse(play.body).serverId, "F4001A2B3C4D5E6F");
    assert.equal(JSON.parse(play.headers["X-MS-Device-Info"]!).dev.displayInfo.dimensions.widthInPixels, 3440);
    const login = f.calls.find((c) => c.url.includes("/v2/login/user"))!;
    assert.equal(JSON.parse(login.body).token, "gssv-xsts");
  });

  it("hands the console over when it's ready, then waits for it", async () => {
    const f = streaming({ "/SESSION1/state": [{ json: { state: "Provisioning" } }, { json: { state: "ReadyToConnect" } }, { json: { state: "Provisioned" } }], "/SESSION1/connect": { status: 202, json: {} } });
    const s = await new XboxLive(signedIn, () => {}, f.impl, () => NOW).startStream("F4001A2B3C4D5E6F");
    const states: string[] = [];
    await s.ready((st) => states.push(st), 5000, 1);
    assert.deepEqual(states, ["Provisioning", "ReadyToConnect", "Provisioned"]);
    const connect = f.calls.find((c) => c.url.endsWith("/connect"))!;
    assert.deepEqual(JSON.parse(connect.body), { userToken: "transfer" });
  });

  it("says why a stream failed", async () => {
    const f = streaming({ "/SESSION1/state": { json: { state: "Failed", errorDetails: { code: "WaitingForServerToRegister" } } } });
    const s = await new XboxLive(signedIn, () => {}, f.impl, () => NOW).startStream("F4001A2B3C4D5E6F");
    await assert.rejects(s.ready(() => {}, 5000, 1), /isn't connected to Xbox Live/);
  });

  it("swaps SDP and ICE, waiting out a 204", async () => {
    const f = streaming({
      "/SESSION1/sdp": (c) => (c.method === "POST" ? { status: 202 } : { json: { exchangeResponse: JSON.stringify({ sdp: "v=0 answer", status: "success" }) } }),
      "/SESSION1/ice": [{ status: 202 }, { status: 204 }, { json: { exchangeResponse: JSON.stringify([{ candidate: "a=candidate:1 1 UDP 1 2001:0:4136:e378:8000:63bf:3fff:fdd2 1234 typ host", sdpMLineIndex: "0", sdpMid: "0" }]) } }],
    });
    const s = await new XboxLive(signedIn, () => {}, f.impl, () => NOW).startStream("F4001A2B3C4D5E6F");
    assert.equal(await s.sdp("v=0 offer"), "v=0 answer");
    const offer = JSON.parse(f.calls.find((c) => c.url.endsWith("/sdp") && c.method === "POST")!.body);
    assert.equal(offer.sdp, "v=0 offer");
    assert.equal(offer.configuration.input.maxVersion, 8);
    const ice = await s.ice([{ candidate: "a=candidate:2 1 UDP 1 192.168.1.5 5000 typ host", sdpMLineIndex: 0, sdpMid: "0" }]);
    assert.deepEqual(ice.map((c) => c.candidate.split(" ").slice(4, 6).join(":")), ["192.0.2.45:9002", "192.0.2.45:40000", "2001:0:4136:e378:8000:63bf:3fff:fdd2:1234"]);
  });

  it("ends the session without minding if it's already gone", async () => {
    const f = streaming({ "/SESSION1": { status: 404 } });
    const s = await new XboxLive(signedIn, () => {}, f.impl, () => NOW).startStream("F4001A2B3C4D5E6F");
    await s.stop();
    assert.equal(f.calls.at(-1)!.method, "DELETE");
  });
});

describe("Teredo candidates", () => {
  it("decodes the client address inside a Teredo address", () => {
    assert.deepEqual(teredoClient("2001:0000:4136:e378:8000:63bf:3fff:fdd2"), { ip: "192.0.2.45", port: 40000 });
    assert.deepEqual(teredoClient("2001::4136:e378:8000:63bf:3fff:fdd2"), { ip: "192.0.2.45", port: 40000 });
    assert.equal(teredoClient("fe80::1"), null);
    assert.equal(teredoClient("192.168.1.5"), null);
  });

  it("leaves ordinary candidates alone", () => {
    const c = [{ candidate: "a=candidate:1 1 UDP 1 192.168.1.5 5000 typ host", sdpMLineIndex: "0", sdpMid: "0" }];
    assert.deepEqual(withTeredo(c), c);
  });

  it("explains a failed stream in words", () => {
    assert.match(streamFailure({ code: "StreamingDisabled" }), /Remote features/);
    assert.match(streamFailure({ code: "Odd", message: "thing" }), /\(Odd: thing\)/);
    assert.match(streamFailure(), /couldn't start the stream$/);
  });
});
