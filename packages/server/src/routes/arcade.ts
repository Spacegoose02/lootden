import type { FastifyInstance } from "fastify";
import { ARCADE_PLATFORM, arcadeGame, arcadeProfileFor, type ArcadeLobby } from "@lootden/shared";
import { HttpProblem, requireUser, type AppContext } from "../context.js";

/** A PC that hasn't checked in for this long has left the race. */
export const LOBBY_TIMEOUT_MS = 10 * 60_000;

interface Member {
  device: string;
  name: string;
  address: string | null;
  joinedAt: number;
  seenAt: number;
}

/**
 * Linked arcade races: PCs that want to race the same game gather here, and each gets a cabinet
 * number in the order it joined (the first PC is cabinet 1). Kept in memory: a race only matters
 * while the PCs are sitting at it.
 */
export function arcadeRoutes(app: FastifyInstance, ctx: AppContext, now: () => number = Date.now) {
  const lobbies = new Map<string, Member[]>();

  const gameFor = (id: string, kid: boolean) => {
    const game = ctx.library.get(id);
    if (!game || (kid && game.kidSafe !== true)) throw new HttpProblem(404, "Game not found");
    if (game.platform !== ARCADE_PLATFORM) throw new HttpProblem(400, "Only arcade games race linked");
    return game;
  };

  const view = (gameId: string, title: string, source: string): ArcadeLobby => {
    const fresh = (lobbies.get(gameId) ?? []).filter((m) => now() - m.seenAt < LOBBY_TIMEOUT_MS);
    if (fresh.length) lobbies.set(gameId, fresh);
    else lobbies.delete(gameId);
    const profile = arcadeProfileFor(source, title);
    return {
      gameId,
      profile,
      maxCabinets: (profile && arcadeGame(profile)?.link?.maxCabinets) || 8,
      members: fresh.map((m, i) => ({ device: m.device, name: m.name, address: m.address, cabinet: i + 1, joinedAt: new Date(m.joinedAt).toISOString() })),
    };
  };

  const cleanDevice = (v: unknown) => {
    const d = typeof v === "string" ? v.trim().slice(0, 80) : "";
    if (!d) throw new HttpProblem(400, "Which PC is this?");
    return d;
  };
  const cleanAddress = (v: unknown) => (typeof v === "string" && /^[0-9a-f.:]{3,45}$/i.test(v.trim()) ? v.trim() : null);

  app.get<{ Params: { id: string } }>("/api/arcade/link/:id", async (req) => {
    const user = requireUser(req);
    const game = gameFor(req.params.id, user.kidMode);
    return view(game.id, game.title, game.source);
  });

  // Joining again keeps the PC's place (and its cabinet number) and counts as still being there.
  app.post<{ Params: { id: string }; Body: { device?: string; address?: string } }>("/api/arcade/link/:id/join", async (req) => {
    const user = requireUser(req);
    const game = gameFor(req.params.id, user.kidMode);
    const device = cleanDevice(req.body?.device);
    const current = view(game.id, game.title, game.source);
    const members = lobbies.get(game.id) ?? [];
    const mine = members.find((m) => m.device.toLowerCase() === device.toLowerCase());
    if (mine) {
      mine.seenAt = now();
      mine.address = cleanAddress(req.body?.address) ?? mine.address;
    } else {
      if (members.length >= current.maxCabinets) throw new HttpProblem(409, `This race is full: ${current.maxCabinets} PCs at most`);
      members.push({ device, name: user.user?.displayName ?? "Player", address: cleanAddress(req.body?.address), joinedAt: now(), seenAt: now() });
      lobbies.set(game.id, members);
    }
    return view(game.id, game.title, game.source);
  });

  app.post<{ Params: { id: string }; Body: { device?: string } }>("/api/arcade/link/:id/leave", async (req) => {
    const user = requireUser(req);
    const game = gameFor(req.params.id, user.kidMode);
    const device = cleanDevice(req.body?.device);
    const rest = (lobbies.get(game.id) ?? []).filter((m) => m.device.toLowerCase() !== device.toLowerCase());
    if (rest.length) lobbies.set(game.id, rest);
    else lobbies.delete(game.id);
    return view(game.id, game.title, game.source);
  });
}
