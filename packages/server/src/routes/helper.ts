import { Readable } from "node:stream";
import Anthropic from "@anthropic-ai/sdk";
import type { FastifyInstance } from "fastify";
import { HELPER_NAME, type HelperChatRequest, type HelperSettings } from "@lootden/shared";
import { HttpProblem, requireAdmin, requirePerson, type AppContext } from "../context.js";
import { HelperProblem, type HelperGameContext } from "../helper/service.js";

/** Bandit, the AI gaming helper: admin settings, who may use him, and the chat itself. */
export function helperRoutes(app: FastifyInstance, ctx: AppContext) {
  const wrap = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (err) {
      if (err instanceof HelperProblem) throw new HttpProblem(err.status, err.message);
      throw err;
    }
  };
  const person = (id: string) => {
    const user = ctx.users.byId(Number(id));
    if (!user) throw new HttpProblem(404, "No such user");
    return user;
  };

  // ---- Admin ---------------------------------------------------------------------------
  app.get("/api/helper/settings", async (req) => {
    requireAdmin(req);
    return ctx.helper.view();
  });
  app.put<{ Body: Partial<HelperSettings> }>("/api/helper/settings", async (req) => {
    requireAdmin(req);
    return wrap(() => ctx.helper.save(req.body ?? {}));
  });

  /** This month's spend against the budget, per person and per day. */
  app.get("/api/helper/usage", async (req) => {
    requireAdmin(req);
    return ctx.helper.usage(ctx.users.list());
  });

  /**
   * A parent's switch for one person (allowed: null goes back to the default, on for grown-ups and
   * off for kids) and their own daily message limit (null: the server's).
   */
  app.get<{ Params: { id: string } }>("/api/users/:id/helper", async (req) => {
    requireAdmin(req);
    return ctx.helper.access(person(req.params.id));
  });
  app.put<{ Params: { id: string }; Body: { allowed?: boolean | null; dailyLimit?: number | null } }>("/api/users/:id/helper", async (req) => {
    requireAdmin(req);
    const { allowed, dailyLimit } = req.body ?? {};
    if (allowed !== undefined && allowed !== null && typeof allowed !== "boolean") throw new HttpProblem(400, "allowed is true, false or null");
    const user = person(req.params.id);
    return wrap(() => ctx.helper.setAccess(user, { allowed, dailyLimit }));
  });

  // ---- Me ------------------------------------------------------------------------------
  app.get("/api/me/helper", async (req) => ctx.helper.status(requirePerson(req)));
  app.put<{ Body: { enabled?: boolean } }>("/api/me/helper", async (req) => {
    const me = requirePerson(req);
    if (typeof req.body?.enabled !== "boolean") throw new HttpProblem(400, "enabled is true or false");
    return ctx.helper.setEnabled(me, req.body.enabled);
  });

  /** Streams Bandit's answer as plain text. Problems before the answer starts are JSON errors. */
  app.post<{ Body: HelperChatRequest }>("/api/helper/chat", async (req, reply) => {
    const me = requirePerson(req);
    const game = gameContext(ctx, me.kidMode, req.body?.game);
    const abort = new AbortController();
    reply.raw.on("close", () => {
      if (!reply.raw.writableFinished) abort.abort();
    });
    const answer = await ctx.helper.chat(me, req.body?.messages, game, abort.signal).catch((err: unknown) => {
      throw err instanceof HelperProblem ? new HttpProblem(err.status, err.message) : err;
    });
    const it = answer[Symbol.asyncIterator]();
    // Wait for the first words, so a bad key or a busy provider is a proper error, not half an answer.
    let first: IteratorResult<string>;
    try {
      first = await it.next();
    } catch (err) {
      ctx.helper.refund(me.id);
      throw providerProblem(err, req.log);
    }
    async function* rest() {
      if (!first.done) yield first.value;
      try {
        for (let r = await it.next(); !r.done; r = await it.next()) yield r.value;
      } catch (err) {
        if (!abort.signal.aborted) {
          req.log.warn({ err }, "Helper answer cut off");
          yield `\n\n(${HELPER_NAME} lost the connection. Try asking again.)`;
        }
      }
    }
    return reply
      .header("content-type", "text/plain; charset=utf-8")
      .header("cache-control", "no-store")
      // Reverse proxies (nginx) would otherwise hold the answer back until it's finished.
      .header("x-accel-buffering", "no")
      .send(Readable.from(rest()));
  });
}

const STORE_NAMES: Record<string, string> = { steam: "Steam", gog: "GOG", epic: "Epic Games", xbox: "Xbox", itch: "itch.io", ubisoft: "Ubisoft Connect", ea: "EA app" };

/** What the person is looking at. Kid profiles can't bring up games they couldn't open. */
function gameContext(ctx: AppContext, kid: boolean, ref: HelperChatRequest["game"]): HelperGameContext | null {
  if (!ref || typeof ref !== "object") return null;
  if ("gameId" in ref && typeof ref.gameId === "string") {
    const g = ctx.library.get(ref.gameId, false);
    if (!g || (kid && g.kidSafe !== true)) return null;
    return { title: g.title, platform: g.platform, genres: g.genres, releaseYear: g.releaseYear, summary: g.metadata?.summary ?? null };
  }
  if ("store" in ref && ref.store && typeof ref.store.title === "string" && ref.store.title.trim()) {
    const addon = typeof ref.store.addon === "string" ? ref.store.addon.slice(0, 30) : null;
    return { title: ref.store.title.trim().slice(0, 120), store: addon ? (STORE_NAMES[addon] ?? addon.replace(/[^\w .-]/g, "")) : null };
  }
  return null;
}

/** The provider's error, in words for the person (and the admin). */
function providerProblem(err: unknown, log: { warn(o: object, m: string): void }): HttpProblem {
  log.warn({ err }, "Helper request failed");
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError)
    return new HttpProblem(502, `The AI key was turned down. An admin can check it in Settings, ${HELPER_NAME} (AI helper).`);
  if (err instanceof Anthropic.RateLimitError) return new HttpProblem(429, `${HELPER_NAME} is getting a lot of questions. Try again in a minute.`);
  if (err instanceof Anthropic.NotFoundError || err instanceof Anthropic.BadRequestError)
    return new HttpProblem(502, `The AI provider didn't accept the request. An admin can pick another model in Settings, ${HELPER_NAME} (AI helper).`);
  if (err instanceof Anthropic.APIConnectionError) return new HttpProblem(502, "Can't reach the AI provider right now.");
  if (err instanceof Anthropic.APIError) return new HttpProblem(502, `The AI provider had a problem (${err.status ?? "no answer"}). Try again soon.`);
  return new HttpProblem(502, `${HELPER_NAME} couldn't answer. Try again soon.`);
}
