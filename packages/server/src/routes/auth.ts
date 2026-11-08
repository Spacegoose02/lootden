import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthProviders } from "@lootden/shared";
import { verifyPassword } from "../auth/crypto.js";
import { isAppNonce } from "../auth/oidc.js";
import { SESSION_COOKIE } from "../auth/service.js";
import { PairingCodes } from "../auth/pairing.js";
import { HttpProblem, requireAdmin, requirePerson, type AppContext } from "../context.js";
import { publicUser, type UserRecord } from "../users/repo.js";

const FAIL_WINDOW_MS = 15 * 60_000;
const MAX_FAILS = 10;
/** A well-formed hash nothing matches, checked when the account is unknown or has no password. */
const DUMMY_HASH = "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$" + Buffer.alloc(32).toString("base64");

export function authRoutes(app: FastifyInstance, ctx: AppContext) {
  const failures = new Map<string, { count: number; since: number }>();
  const secure = ctx.config.publicUrl.startsWith("https://");

  const startSession = (req: FastifyRequest, reply: FastifyReply, user: UserRecord) => {
    const { token, maxAgeSeconds } = ctx.auth.createSession(user.id, req.headers["user-agent"]);
    reply.setCookie(SESSION_COOKIE, token, { path: "/", httpOnly: true, sameSite: "lax", secure, maxAge: maxAgeSeconds });
  };

  app.get("/api/auth/providers", async (): Promise<AuthProviders> => ({
    local: true,
    oidc: { enabled: ctx.oidc.enabled, name: ctx.config.oidc.name, appHandoff: true },
    header: !!ctx.config.headerAuth.userHeader,
    setupRequired: ctx.users.count() === 0,
    pairing: true,
  }));

  /** Creates the first admin. Only works while there are no accounts. */
  app.post<{ Body: { username: string; password: string; displayName?: string } }>("/api/auth/setup", async (req, reply) => {
    if (ctx.users.count() > 0) throw new HttpProblem(409, "Setup is already done");
    const { username, password, displayName } = req.body ?? ({} as never);
    if (!password) throw new HttpProblem(400, "A password is required");
    const user = await ctx.users.create({ username, password, displayName, role: "admin" });
    startSession(req, reply, user);
    return publicUser(user);
  });

  /**
   * Password login. Browsers get a session cookie; clients pass {client: true, device}
   * and get a personal API token back instead.
   */
  app.post<{ Body: { username: string; password: string; client?: boolean; device?: string; code?: string } }>("/api/auth/login", async (req, reply) => {
    const { username = "", password = "", client, device, code } = req.body ?? ({} as never);
    const key = `${req.ip}|${String(username).toLowerCase()}`;
    const at = Date.now();
    if (failures.size > 10_000) for (const [k, v] of failures) if (at - v.since >= FAIL_WINDOW_MS) failures.delete(k);
    const f = failures.get(key);
    const entry = f && at - f.since < FAIL_WINDOW_MS ? f : { count: 0, since: at };
    if (entry.count >= MAX_FAILS) throw new HttpProblem(429, "Too many failed attempts; wait 15 minutes");
    // Counted before the (slow) password check, so a burst of parallel guesses can't all slip past the limit.
    entry.count++;
    failures.set(key, entry);
    const user = ctx.users.byUsername(String(username));
    // Unknown names take as long as wrong passwords, so timing doesn't reveal which accounts exist.
    const ok = await verifyPassword(String(password), user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) throw new HttpProblem(401, "Wrong username or password");
    // Two-step sign-in: a code in the same request (the CLI), or a ticket for the second step (browsers).
    const second = ctx.mfa.required(user.id);
    if (second) {
      if (code) {
        if (!ctx.mfa.checkCode(user.id, String(code))) throw new HttpProblem(401, "That code isn't right");
      } else if (client) {
        throw new HttpProblem(401, "This account uses two-step sign-in; add the 6-digit code from your authenticator app (--code)");
      } else {
        failures.delete(key);
        return { mfa: { ticket: ctx.mfa.issueTicket(user.id), ...second } };
      }
    }
    failures.delete(key);
    if (client) {
      const { token } = ctx.auth.createApiToken(user.id, device || "LootDen client");
      return { token, user: publicUser(user) };
    }
    startSession(req, reply, user);
    return { user: publicUser(user) };
  });

  // ---- Two-step sign-in: the second step, and passkeys -----------------------------------

  /** The host name passkeys are tied to: the address the browser is on. */
  const rpId = (req: FastifyRequest) => req.hostname.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");

  app.post<{ Body: { ticket?: string; code?: string } }>("/api/auth/login/mfa", async (req, reply) => {
    const { ticket = "", code = "" } = req.body ?? {};
    const userId = ctx.mfa.ticketUser(String(ticket));
    if (userId === null) throw new HttpProblem(401, "Sign-in timed out; enter your password again");
    const key = `${req.ip}|mfa|${userId}`;
    const at = Date.now();
    const f = failures.get(key);
    const entry = f && at - f.since < FAIL_WINDOW_MS ? f : { count: 0, since: at };
    if (entry.count >= MAX_FAILS) throw new HttpProblem(429, "Too many wrong codes; wait 15 minutes");
    entry.count++;
    failures.set(key, entry);
    const user = ctx.users.byId(userId);
    if (!user || !ctx.mfa.checkCode(userId, String(code))) throw new HttpProblem(401, "That code isn't right");
    failures.delete(key);
    ctx.mfa.endTicket(String(ticket));
    startSession(req, reply, user);
    return { user: publicUser(user) };
  });

  /** Options for a passkey sign-in: after a password (with its ticket), or on its own. */
  app.post<{ Body: { ticket?: string } }>("/api/auth/passkey/options", async (req) => {
    const ticket = req.body?.ticket;
    const userId = ticket ? ctx.mfa.ticketUser(String(ticket)) : null;
    if (ticket && userId === null) throw new HttpProblem(401, "Sign-in timed out; enter your password again");
    return ctx.mfa.assertionOptions(userId, rpId(req));
  });

  app.post<{ Body: { ticket?: string; credential?: unknown } }>("/api/auth/passkey", async (req, reply) => {
    const ticket = req.body?.ticket;
    let userId: number;
    try {
      userId = ctx.mfa.usePasskey(req.body?.credential as never, rpId(req));
    } catch (err) {
      throw new HttpProblem(401, (err as Error).message);
    }
    if (ticket) {
      if (ctx.mfa.ticketUser(String(ticket)) !== userId) throw new HttpProblem(401, "That passkey belongs to someone else");
      ctx.mfa.endTicket(String(ticket));
    }
    const user = ctx.users.byId(userId);
    if (!user) throw new HttpProblem(401, "That account is gone");
    startSession(req, reply, user);
    return { user: publicUser(user) };
  });

  // ---- My sign-in security (Profile) --------------------------------------------------

  app.get("/api/me/security", async (req) => ctx.mfa.status(requirePerson(req).id));

  app.post("/api/me/security/totp", async (req) => {
    const me = requirePerson(req);
    return ctx.mfa.beginTotp(me.id, me.username);
  });

  app.post<{ Body: { code?: string } }>("/api/me/security/totp/confirm", async (req) => {
    const me = requirePerson(req);
    try {
      return { recoveryCodes: ctx.mfa.confirmTotp(me.id, String(req.body?.code ?? "")) };
    } catch (err) {
      throw new HttpProblem(400, (err as Error).message);
    }
  });

  /** Turning it off, or new recovery codes, takes a current code so a borrowed session can't. */
  app.post<{ Body: { code?: string } }>("/api/me/security/totp/off", async (req) => {
    const me = requirePerson(req);
    if (!ctx.mfa.checkCode(me.id, String(req.body?.code ?? ""))) throw new HttpProblem(403, "That code isn't right");
    ctx.mfa.disableTotp(me.id);
    return ctx.mfa.status(me.id);
  });

  app.post<{ Body: { code?: string } }>("/api/me/security/recovery", async (req) => {
    const me = requirePerson(req);
    const s = ctx.mfa.status(me.id);
    if (!s.totp && !s.passkeys.length) throw new HttpProblem(400, "Turn on two-step sign-in first");
    if (s.totp && !ctx.mfa.checkCode(me.id, String(req.body?.code ?? ""))) throw new HttpProblem(403, "That code isn't right");
    return { recoveryCodes: ctx.mfa.newRecoveryCodes(me.id) };
  });

  app.post("/api/me/security/passkeys/options", async (req) => {
    const me = requirePerson(req);
    return ctx.mfa.registrationOptions({ id: me.id, username: me.username, displayName: me.displayName }, rpId(req));
  });

  app.post<{ Body: { credential?: unknown; name?: string } }>("/api/me/security/passkeys", async (req) => {
    const me = requirePerson(req);
    const fresh = !ctx.mfa.required(me.id);
    try {
      const key = ctx.mfa.addPasskey(me.id, req.body?.credential as never, rpId(req), String(req.body?.name ?? ""));
      // The first passkey turns on two-step sign-in, so it comes with recovery codes.
      return { passkey: key, recoveryCodes: fresh && !ctx.mfa.status(me.id).recoveryLeft ? ctx.mfa.newRecoveryCodes(me.id) : [] };
    } catch (err) {
      throw new HttpProblem(400, (err as Error).message);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/me/security/passkeys/:id", async (req) => {
    const me = requirePerson(req);
    if (!ctx.mfa.removePasskey(me.id, req.params.id)) throw new HttpProblem(404, "No such passkey");
    return ctx.mfa.status(me.id);
  });

  /** An admin clears a locked-out person's authenticator app and passkeys. */
  app.delete<{ Params: { id: string } }>("/api/users/:id/mfa", async (req) => {
    requireAdmin(req);
    ctx.mfa.reset(Number(req.params.id));
    return { ok: true };
  });

  // ---- Pairing codes: sign a new device in from one that's signed in already ----------------

  const pairing = new PairingCodes();

  /** A signed-in person asks for a code (Profile, Link a device). */
  app.post("/api/auth/pair", async (req) => {
    const user = requirePerson(req);
    return pairing.issue(user.id);
  });

  /** The new device trades the code for a session (browsers) or an API token ({client: true}). */
  app.post<{ Body: { code?: string; client?: boolean; device?: string } }>("/api/auth/pair/redeem", async (req, reply) => {
    const { code = "", client, device } = req.body ?? {};
    const key = `${req.ip}|pairing`;
    const at = Date.now();
    const f = failures.get(key);
    const entry = f && at - f.since < FAIL_WINDOW_MS ? f : { count: 0, since: at };
    if (entry.count >= MAX_FAILS) throw new HttpProblem(429, "Too many wrong codes; wait 15 minutes");
    const userId = pairing.redeem(String(code));
    const user = userId === null ? null : ctx.users.byId(userId);
    if (!user) {
      entry.count++;
      failures.set(key, entry);
      throw new HttpProblem(401, "That code is wrong or has expired; get a new one on your other device");
    }
    if (client) {
      const { token } = ctx.auth.createApiToken(user.id, String(device || "LootDen client").slice(0, 100));
      return { token, user: publicUser(user) };
    }
    startSession(req, reply, user);
    return { user: publicUser(user) };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) ctx.auth.endSession(token);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  /** ?app=<nonce> comes from the desktop app, which opens this in the system browser. */
  app.get<{ Querystring: { returnTo?: string; app?: string } }>("/api/auth/oidc/login", async (req, reply) => {
    if (!ctx.oidc.enabled) throw new HttpProblem(404, "Single sign-on is not configured");
    const appNonce = isAppNonce(req.query.app) ? req.query.app : undefined;
    return reply.redirect(await ctx.oidc.start(req.query.returnTo, appNonce));
  });

  app.get("/api/auth/oidc/callback", async (req, reply) => {
    if (!ctx.oidc.enabled) throw new HttpProblem(404, "Single sign-on is not configured");
    try {
      const { user, returnTo, appNonce } = await ctx.oidc.finish(new URL(req.url, ctx.config.publicUrl));
      if (appNonce) return reply.type("text/html").send(handoffPage(`lootden://auth?code=${ctx.oidc.issueHandoff(user.id, appNonce, returnTo)}`));
      startSession(req, reply, user);
      return reply.redirect(returnTo);
    } catch (err) {
      req.log.warn({ err: (err as Error).message }, "OIDC login failed");
      return reply.redirect(`/login?error=${encodeURIComponent((err as Error).message)}`);
    }
  });

  /** The desktop app loads this with the code from the browser, and gets its session here. */
  app.get<{ Querystring: { code?: string; app?: string } }>("/api/auth/oidc/app", async (req, reply) => {
    const done = isAppNonce(req.query.app) ? ctx.oidc.redeemHandoff(String(req.query.code ?? ""), req.query.app) : null;
    const user = done && ctx.users.byId(done.userId);
    if (!done || !user) return reply.redirect(`/login?error=${encodeURIComponent("Sign-in expired or was started elsewhere; try again")}`);
    startSession(req, reply, user);
    return reply.redirect(done.returnTo);
  });
}

/** Shown in the system browser after a desktop sign-in: hands the code to the app. */
function handoffPage(link: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Signed in to LootDen</title>
<style>body{font-family:system-ui,sans-serif;background:#0d0820;color:#f3eeff;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center}a{color:#c9a7ff}</style></head>
<body><main><h1>Signed in</h1><p>You can close this tab and go back to LootDen.</p><p><a href="${link}">Open LootDen</a></p></main>
<script>location.href=${JSON.stringify(link)}</script></body></html>`;
}
