import type { FastifyInstance } from "fastify";
import { requireUser, type AppContext } from "../context.js";

/** Streams are closed after this long; the browser reconnects, which checks the sign-in again. */
const MAX_STREAM_MS = 60 * 60_000;

/** GET /api/events: server-sent events naming what changed (see live.ts). */
export function liveRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/api/events", async (req, reply) => {
    const admin = requireUser(req).role === "admin";
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      // nginx and similar proxies would otherwise hold events back in a buffer.
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    });
    res.write("retry: 5000\n\n");
    const offEvent = ctx.live.subscribe((e) => {
      if (!e.adminOnly || admin) res.write(`event: ${e.topic}\ndata: {}\n\n`);
    });
    const end = () => res.end();
    const offClose = ctx.live.onClose(end);
    // Comments keep proxies and tunnels from timing the stream out.
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    const expire = setTimeout(end, MAX_STREAM_MS);
    res.on("close", () => {
      clearInterval(ping);
      clearTimeout(expire);
      offEvent();
      offClose();
    });
  });
}
