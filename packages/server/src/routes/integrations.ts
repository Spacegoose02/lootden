import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PriceSettings } from "@lootden/shared";
import { HttpProblem, requireAdmin, requireUser, type AppContext } from "../context.js";
import type { HomeAssistantSettings } from "../integrations/homeassistant.js";

const fail = async <T>(fn: () => T | Promise<T>, status = 400): Promise<T> => {
  try {
    return await fn();
  } catch (err) {
    throw new HttpProblem(status, (err as Error).message);
  }
};

/** ProtonDB and Steam Deck badges, wishlist prices, and Home Assistant. */
export function integrationRoutes(app: FastifyInstance, ctx: AppContext) {
  const grownUp = (req: FastifyRequest) => {
    if (requireUser(req).kidMode) throw new HttpProblem(403, "Not available on kid profiles");
  };

  // ---- ProtonDB and Steam Deck --------------------------------------------------------------

  app.get<{ Params: { appId: string } }>("/api/compat/steam/:appId", async (req) => {
    requireUser(req);
    if (!/^\d{1,10}$/.test(req.params.appId)) throw new HttpProblem(400, "Not a Steam app id");
    return fail(() => ctx.compat.get(req.params.appId), 502);
  });

  // ---- Wishlist prices ----------------------------------------------------------------------

  const priceState = (req: FastifyRequest) => {
    const admin = requireUser(req).role === "admin";
    const s = ctx.prices.view();
    return { enabled: s.hasKey, settings: admin ? s : null, country: s.country, prices: s.hasKey ? ctx.prices.list() : [] };
  };

  app.get("/api/wishlist/prices", async (req) => priceState(req));

  app.put<{ Body: Partial<PriceSettings> }>("/api/wishlist/prices/settings", async (req) => {
    requireAdmin(req);
    ctx.prices.saveSettings(req.body ?? {});
    return priceState(req);
  });

  app.post("/api/wishlist/prices/check", async (req) => {
    grownUp(req);
    const r = await fail(() => ctx.prices.check(), 502);
    return { ...priceState(req), ...r };
  });

  app.put<{ Params: { id: string }; Body: { target?: number | null } }>("/api/wishlist/:id/target", async (req) => {
    grownUp(req);
    const t = req.body?.target;
    await fail(() => ctx.prices.setTarget(Number(req.params.id), t == null ? null : Number(t)));
    return priceState(req);
  });

  // ---- Home Assistant -----------------------------------------------------------------------

  app.get("/api/homeassistant", async (req) => {
    requireAdmin(req);
    return ctx.homeAssistant.view();
  });
  app.put<{ Body: Partial<HomeAssistantSettings> }>("/api/homeassistant", async (req) => {
    requireAdmin(req);
    return fail(() => ctx.homeAssistant.save(req.body ?? {}));
  });
  app.post("/api/homeassistant/test", async (req) => {
    requireAdmin(req);
    await fail(() => ctx.homeAssistant.test(), 502);
    return ctx.homeAssistant.view();
  });
}
