import assert from "node:assert/strict";
import { createDecipheriv, createECDH, createHmac, createPublicKey, randomBytes, verify } from "node:crypto";
import { rm } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { makeApp, makeLibrary, sessionCookie } from "./helpers.js";

let root: string;
before(async () => (root = await makeLibrary()));
after(async () => rm(root, { recursive: true, force: true }));

const hmac = (k: Buffer, d: Buffer) => createHmac("sha256", k).update(d).digest();

/** What the browser does with an aes128gcm push message (RFC 8291), to check the server's side. */
function decrypt(body: Buffer, ua: ReturnType<typeof createECDH>, auth: Buffer): string {
  const salt = body.subarray(0, 16);
  const idlen = body[20]!;
  const asPublic = body.subarray(21, 21 + idlen);
  const data = body.subarray(21 + idlen);
  const shared = ua.computeSecret(asPublic);
  const ikm = hmac(hmac(auth, shared), Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
  const d = createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2, "last record delimiter");
  return plain.subarray(0, -1).toString("utf8");
}

describe("Push notifications", () => {
  it("encrypts for the browser, signs with VAPID, and forgets gone devices", async () => {
    const sent: Array<{ url: string; headers: Record<string, string>; body: Buffer }> = [];
    let status = 201;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      sent.push({ url: String(url), headers: init.headers as Record<string, string>, body: Buffer.from(init.body as Uint8Array) });
      return new Response(null, { status });
    }) as unknown as typeof fetch;
    const { app, ctx } = await makeApp(root, {}, { fetchImpl });
    await ctx.users.create({ username: "dad", password: "password123", role: "admin" });
    const cookie = sessionCookie(await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "dad", password: "password123" } }));

    const ua = createECDH("prime256v1");
    ua.generateKeys();
    const auth = randomBytes(16);
    const subscription = { endpoint: "https://push.example/send/abc", keys: { p256dh: ua.getPublicKey().toString("base64url"), auth: auth.toString("base64url") } };
    const info = (await app.inject({ url: "/api/push", headers: { cookie } })).json();
    assert.equal(Buffer.from(info.publicKey, "base64url").length, 65);
    assert.equal((await app.inject({ method: "POST", url: "/api/push/subscribe", headers: { cookie }, payload: { subscription: { endpoint: "http://x" } } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: "/api/push/subscribe", headers: { cookie }, payload: { subscription } })).json().devices, 1);

    const test = await app.inject({ method: "POST", url: "/api/push/test", headers: { cookie } });
    assert.equal(test.statusCode, 200, test.body);
    const msg = sent.at(-1)!;
    assert.equal(msg.url, subscription.endpoint);
    assert.equal(msg.headers["Content-Encoding"], "aes128gcm");
    assert.equal(JSON.parse(decrypt(msg.body, ua, auth)).title, "LootDen notifications work");

    // VAPID: a JWT for the push service's origin, signed with the key the browser subscribed with.
    const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(msg.headers.Authorization!)!;
    assert.equal(k, info.publicKey);
    const [h, c, s] = jwt!.split(".");
    assert.equal(JSON.parse(Buffer.from(c!, "base64url").toString()).aud, "https://push.example");
    const pub = Buffer.from(k!, "base64url");
    const key = createPublicKey({ format: "jwk", key: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") } });
    assert.ok(verify("sha256", Buffer.from(`${h}.${c}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(s!, "base64url")));

    // Admin alerts go out as pushes too.
    await ctx.notifier.send("test", "Hello from the bell");
    assert.equal(JSON.parse(decrypt(sent.at(-1)!.body, ua, auth)).title, "Hello from the bell");

    // The browser unsubscribed: the push service says 410 and the device is dropped.
    status = 410;
    await app.inject({ method: "POST", url: "/api/push/test", headers: { cookie } });
    assert.equal((await app.inject({ url: "/api/push", headers: { cookie } })).json().devices, 0);
  });
});
