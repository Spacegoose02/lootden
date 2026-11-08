import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { rm } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { base32Decode, base32Encode, totp, verifyTotp } from "../src/auth/totp.js";
import { decodeCbor } from "../src/auth/webauthn.js";
import { makeApp, makeLibrary, sessionCookie } from "./helpers.js";

let root: string;
before(async () => (root = await makeLibrary()));
after(async () => rm(root, { recursive: true, force: true }));

// ---- A software passkey, as a phone or security key would answer ---------------------

function cbor(v: unknown): Buffer {
  const head = (major: number, n: number) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(n, 1);
    return b;
  };
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error("cbor");
}

const HOST = "localhost";
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest();

class SoftKey {
  private readonly keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  readonly id = Buffer.from("soft-key-1").toString("base64url");
  count = 0;
  create(challenge: string) {
    const jwk = this.keys.publicKey.export({ format: "jwk" });
    const cose = new Map<number, unknown>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x!, "base64url")],
      [-3, Buffer.from(jwk.y!, "base64url")],
    ]);
    const credId = Buffer.from(this.id, "base64url");
    const len = Buffer.alloc(2);
    len.writeUInt16BE(credId.length);
    const authData = Buffer.concat([sha(HOST), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), len, credId, cbor(cose)]);
    const clientData = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge, origin: `http://${HOST}:5173` }));
    return {
      id: this.id,
      response: { clientDataJSON: clientData.toString("base64url"), attestationObject: cbor(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]])).toString("base64url") },
    };
  }
  get(challenge: string, origin = `http://${HOST}:5173`) {
    this.count++;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.count);
    const authData = Buffer.concat([sha(HOST), Buffer.from([0x05]), counter]);
    const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin }));
    const signature = sign("sha256", Buffer.concat([authData, sha(clientData)]), this.keys.privateKey);
    return { id: this.id, response: { clientDataJSON: clientData.toString("base64url"), authenticatorData: authData.toString("base64url"), signature: signature.toString("base64url") } };
  }
}

describe("Two-step sign-in", () => {
  it("does TOTP the RFC 6238 way", () => {
    // RFC 6238's SHA-1 test secret, at 59 seconds: 94287082 -> its last 6 digits.
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    assert.equal(totp(secret, 59_000), "287082");
    assert.equal(totp(secret, 1111111109_000), "081804");
    assert.deepEqual(base32Decode(secret), Buffer.from("12345678901234567890"));
    const step = verifyTotp(secret, "287082", 59_000);
    assert.equal(step, 1);
    assert.equal(verifyTotp(secret, "287082", 59_000, step!), null, "a code works once");
    assert.equal(decodeCbor(cbor(new Map([["a", -7]]))).value instanceof Map, true);
  });

  it("asks for a code or a passkey after the password", async () => {
    const { app, ctx } = await makeApp(root);
    await ctx.users.create({ username: "mum", password: "password123", role: "admin" });
    const login = (body: object = {}) => app.inject({ method: "POST", url: "/api/auth/login", headers: { host: `${HOST}:5173` }, payload: { username: "mum", password: "password123", ...body } });
    const cookie = sessionCookie(await login());
    const me = { cookie, host: `${HOST}:5173` };

    // Authenticator app.
    const begin = (await app.inject({ method: "POST", url: "/api/me/security/totp", headers: me })).json();
    assert.match(begin.uri, /^otpauth:\/\/totp\/LootDen:mum\?secret=/);
    assert.equal((await app.inject({ method: "POST", url: "/api/me/security/totp/confirm", headers: me, payload: { code: "000000" } })).statusCode, 400);
    const confirm = await app.inject({ method: "POST", url: "/api/me/security/totp/confirm", headers: me, payload: { code: totp(begin.secret) } });
    const recovery = confirm.json().recoveryCodes as string[];
    assert.equal(recovery.length, 10);

    // The password alone now answers a ticket, not a session.
    const step1 = await login();
    assert.equal(step1.cookies.length, 0);
    const { ticket, totp: wantsCode } = step1.json().mfa;
    assert.equal(wantsCode, true);
    assert.equal((await app.inject({ method: "POST", url: "/api/auth/login/mfa", payload: { ticket, code: "123456" } })).statusCode, 401);
    const ok = await app.inject({ method: "POST", url: "/api/auth/login/mfa", payload: { ticket, code: recovery[0] } });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.ok(sessionCookie(ok));
    assert.equal((await app.inject({ method: "POST", url: "/api/auth/login/mfa", payload: { ticket, code: recovery[1] } })).statusCode, 401, "a ticket works once");
    assert.equal((await login({ client: true })).statusCode, 401, "the CLI needs --code");
    const second = (await login()).json().mfa.ticket;
    assert.equal((await app.inject({ method: "POST", url: "/api/auth/login/mfa", payload: { ticket: second, code: recovery[0] } })).statusCode, 401, "recovery codes are one-time");

    // A passkey: added from the profile, then used on its own, without a password.
    const key = new SoftKey();
    const regOpts = (await app.inject({ method: "POST", url: "/api/me/security/passkeys/options", headers: me })).json();
    assert.equal(regOpts.rp.id, HOST);
    const added = await app.inject({ method: "POST", url: "/api/me/security/passkeys", headers: me, payload: { credential: key.create(regOpts.challenge), name: "Phone" } });
    assert.equal(added.statusCode, 200, added.body);
    assert.equal(added.json().passkey.name, "Phone");

    const getOpts = (await app.inject({ method: "POST", url: "/api/auth/passkey/options", headers: { host: `${HOST}:5173` }, payload: {} })).json();
    const signedIn = await app.inject({ method: "POST", url: "/api/auth/passkey", headers: { host: `${HOST}:5173` }, payload: { credential: key.get(getOpts.challenge) } });
    assert.equal(signedIn.statusCode, 200, signedIn.body);
    assert.equal(signedIn.json().user.username, "mum");
    // Replaying the same answer fails: the challenge is used up.
    const again = await app.inject({ method: "POST", url: "/api/auth/passkey", headers: { host: `${HOST}:5173` }, payload: { credential: key.get(getOpts.challenge) } });
    assert.equal(again.statusCode, 401);
    // A phishing site's origin doesn't pass.
    const o2 = (await app.inject({ method: "POST", url: "/api/auth/passkey/options", headers: { host: `${HOST}:5173` }, payload: {} })).json();
    const phish = await app.inject({ method: "POST", url: "/api/auth/passkey", headers: { host: `${HOST}:5173` }, payload: { credential: key.get(o2.challenge, "https://evil.example") } });
    assert.equal(phish.statusCode, 401);

    // Turning the app off takes a current code; an admin can reset everything.
    assert.equal((await app.inject({ method: "POST", url: "/api/me/security/totp/off", headers: me, payload: { code: "000000" } })).statusCode, 403);
    const status = (await app.inject({ url: "/api/me/security", headers: me })).json();
    assert.equal(status.totp, true);
    assert.equal(status.passkeys.length, 1);
    const id = ctx.users.byUsername("mum")!.id;
    assert.equal((await app.inject({ method: "DELETE", url: `/api/users/${id}/mfa`, headers: me })).statusCode, 200);
    assert.ok(sessionCookie(await login()), "back to a password alone");
  });
});
