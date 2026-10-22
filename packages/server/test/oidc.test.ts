import assert from "node:assert/strict";
import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import { rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { makeApp, makeLibrary, sessionCookie } from "./helpers.js";

/** Minimal OpenID provider: discovery, JWKS and a token endpoint that checks PKCE. */
async function fakeIdp(claims: Record<string, unknown>) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
  const codes = new Map<string, string>(); // code -> code_challenge
  let issuer = "";
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url!, issuer);
    const send = (status: number, body: object) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/.well-known/openid-configuration") {
      return send(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.pathname === "/jwks") return send(200, { keys: [jwk] });
    if (url.pathname === "/token") {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        const form = new URLSearchParams(raw);
        const challenge = codes.get(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        if (!challenge || createHash("sha256").update(verifier).digest("base64url") !== challenge) return send(400, { error: "invalid_grant" });
        const now = Math.floor(Date.now() / 1000);
        const header = b64({ alg: "RS256", kid: "k1", typ: "JWT" });
        const payload = b64({ iss: issuer, aud: "gm", iat: now, exp: now + 300, ...claims });
        const sig = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(privateKey).toString("base64url");
        send(200, { access_token: "at", token_type: "Bearer", expires_in: 300, id_token: `${header}.${payload}.${sig}` });
      });
      return;
    }
    send(404, { error: "not found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    issuer,
    /** Plays the user approving the login at the provider: returns the callback URL. */
    approve(authorizeUrl: string): string {
      const u = new URL(authorizeUrl);
      const code = `code-${Math.random().toString(36).slice(2)}`;
      codes.set(code, u.searchParams.get("code_challenge")!);
      return `${u.searchParams.get("redirect_uri")}?code=${code}&state=${u.searchParams.get("state")}`;
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

let root: string;
before(async () => {
  root = await makeLibrary();
});
after(() => rm(root, { recursive: true, force: true }));

describe("OIDC single sign-on", () => {
  it("logs in through the provider, creates the account and maps the admin group", async () => {
    const idp = await fakeIdp({ sub: "user-42", preferred_username: "underwood", name: "Underwood", email: "u@example.com", groups: ["gm-admins"] });
    const { app } = await makeApp(root, {
      publicUrl: "https://games.example.com",
      oidc: { issuer: idp.issuer, clientId: "gm", clientSecret: "s3cret", name: "TinyAuth", scopes: "openid profile email groups", autoCreate: true, adminGroup: "gm-admins" },
    });
    const providers = (await app.inject("/api/auth/providers")).json();
    assert.deepEqual(providers.oidc, { enabled: true, name: "TinyAuth", appHandoff: true });

    const start = await app.inject("/api/auth/oidc/login?returnTo=/library");
    assert.equal(start.statusCode, 302);
    const authorizeUrl = start.headers.location as string;
    assert.ok(authorizeUrl.startsWith(`${idp.issuer}/authorize`));
    assert.equal(new URL(authorizeUrl).searchParams.get("code_challenge_method"), "S256");

    const callback = new URL(idp.approve(authorizeUrl));
    assert.equal(callback.origin + callback.pathname, "https://games.example.com/api/auth/oidc/callback");
    const done = await app.inject(callback.pathname + callback.search);
    assert.equal(done.statusCode, 302);
    assert.equal(done.headers.location, "/library");
    const cookie = sessionCookie(done);
    const me = (await app.inject({ url: "/api/me", headers: { cookie } })).json();
    assert.equal(me.user.username, "underwood");
    assert.equal(me.user.email, "u@example.com");
    assert.equal(me.role, "admin");

    // Replaying the same callback fails cleanly.
    const replay = await app.inject(callback.pathname + callback.search);
    assert.match(String(replay.headers.location), /^\/login\?error=/);
    await app.close();
    await idp.close();
  });

  it("hands a sign-in from the system browser back to the desktop app that started it", async () => {
    const idp = await fakeIdp({ sub: "user-7", preferred_username: "deck", email: "deck@example.com" });
    const { app } = await makeApp(root, {
      publicUrl: "https://games.example.com",
      oidc: { issuer: idp.issuer, clientId: "gm", clientSecret: "s3cret", name: "TinyAuth", scopes: "openid email", autoCreate: true, adminGroup: "" },
    });
    const nonce = "n".repeat(43);
    const start = await app.inject(`/api/auth/oidc/login?returnTo=/library&app=${nonce}`);
    const cb = new URL(idp.approve(start.headers.location as string));
    const done = await app.inject(cb.pathname + cb.search);
    // The browser gets no session, only a page that opens the app with a one-time code.
    assert.equal(done.statusCode, 200);
    assert.equal(done.cookies.find((c) => c.name === "gm_session"), undefined);
    const code = done.body.match(/lootden:\/\/auth\?code=([\w-]+)/)?.[1];
    assert.ok(code);

    // Another app (or a planted link) without the nonce can't use the code, and burns it.
    const wrong = await app.inject(`/api/auth/oidc/app?code=${code}&app=${"x".repeat(43)}`);
    assert.match(String(wrong.headers.location), /^\/login\?error=/);
    const late = await app.inject(`/api/auth/oidc/app?code=${code}&app=${nonce}`);
    assert.match(String(late.headers.location), /^\/login\?error=/);

    // The app that started it gets the session.
    const again = await app.inject(`/api/auth/oidc/login?app=${nonce}`);
    const cb2 = new URL(idp.approve(again.headers.location as string));
    const code2 = (await app.inject(cb2.pathname + cb2.search)).body.match(/code=([\w-]+)/)![1];
    const redeemed = await app.inject(`/api/auth/oidc/app?code=${code2}&app=${nonce}`);
    assert.equal(redeemed.statusCode, 302);
    assert.equal(redeemed.headers.location, "/");
    const me = (await app.inject({ url: "/api/me", headers: { cookie: sessionCookie(redeemed) } })).json();
    assert.equal(me.user.username, "deck");
    await app.close();
    await idp.close();
  });

  it("links to an existing account by email instead of creating a duplicate", async () => {
    const idp = await fakeIdp({ sub: "abc", preferred_username: "someone-else", email: "sam@example.com" });
    const { app, ctx } = await makeApp(root, {
      publicUrl: "https://games.example.com",
      oidc: { issuer: idp.issuer, clientId: "gm", clientSecret: "", name: "SSO", scopes: "openid email", autoCreate: false, adminGroup: "" },
    });
    const sam = await ctx.users.create({ username: "sam", email: "sam@example.com", password: "password1" });
    const start = await app.inject("/api/auth/oidc/login");
    const cb = new URL(idp.approve(start.headers.location as string));
    const done = await app.inject(cb.pathname + cb.search);
    const me = (await app.inject({ url: "/api/me", headers: { cookie: sessionCookie(done) } })).json();
    assert.equal(me.user.id, sam.id);
    assert.equal(ctx.users.count(), 1);
    assert.equal(ctx.users.byId(sam.id)!.oidcSubject, "abc");
    await app.close();
    await idp.close();
  });

  it("never takes over a local account by username, or by an email the provider hasn't verified", async () => {
    const config = (issuer: string) => ({
      publicUrl: "https://games.example.com",
      oidc: { issuer, clientId: "gm", clientSecret: "", name: "SSO", scopes: "openid email", autoCreate: true, adminGroup: "" },
    });
    const signIn = async (claims: Record<string, unknown>) => {
      const idp = await fakeIdp(claims);
      const { app, ctx } = await makeApp(root, config(idp.issuer));
      const admin = await ctx.users.create({ username: "admin", email: "boss@example.com", password: "password1", role: "admin" });
      const start = await app.inject("/api/auth/oidc/login");
      const cb = new URL(idp.approve(start.headers.location as string));
      const done = await app.inject(cb.pathname + cb.search);
      const linked = ctx.users.byId(admin.id)!.oidcSubject;
      await app.close();
      await idp.close();
      return { done, linked };
    };

    // admin@gmail.com (or a chosen nickname) must not become the local "admin".
    for (const claims of [{ sub: "g1", email: "admin@gmail.com", email_verified: true }, { sub: "g2", preferred_username: "admin" }]) {
      const { done, linked } = await signIn(claims);
      assert.equal(linked, null);
      assert.match(decodeURIComponent(String(done.headers.location)), /already an account named admin/);
    }
    const unverified = await signIn({ sub: "g3", preferred_username: "someone", email: "boss@example.com", email_verified: false });
    assert.equal(unverified.linked, null);
  });
});
