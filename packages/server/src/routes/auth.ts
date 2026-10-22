import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthProviders } from "@lootden/shared";
import { verifyPassword } from "../auth/crypto.js";
import { isAppNonce } from "../auth/oidc.js";
import { SESSION_COOKIE } from "../auth/service.js";
import { HttpProblem, type AppContext } from "../context.js";
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
  app.post<{ Body: { username: string; password: string; client?: boolean; device?: string } }>("/api/auth/login", async (req, reply) => {
    const { username = "", password = "", client, device } = req.body ?? ({} as never);
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
    failures.delete(key);
    if (client) {
      const { token } = ctx.auth.createApiToken(user.id, device || "LootDen client");
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
