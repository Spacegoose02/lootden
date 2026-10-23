import { randomBytes } from "node:crypto";
import type { FetchLike } from "../metadata/http.js";

const OPENID = "https://steamcommunity.com/openid/login";
const NS = "http://specs.openid.net/auth/2.0";
const SELECT = "http://specs.openid.net/auth/2.0/identifier_select";
const LIFETIME_MS = 10 * 60_000;
export const STEAM_CALLBACK = "/api/addons/steam/signin/callback";

/**
 * "Sign in with Steam" (Steam's OpenID 2.0) so people don't have to find their Steam ID. It only
 * proves which Steam account someone has; reading its games still takes a Web API key, theirs or
 * the server-wide one. The callback finds the LootDen person by a one-time state value rather
 * than their cookie, because the desktop app finishes the sign-in in the system browser.
 */
export class SteamSignIn {
  private readonly pending = new Map<string, { userId: number; returnTo: string; expires: number }>();

  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  /** Steam's sign-in page for this person. base is the server's public address. */
  start(userId: number, base: string, at = Date.now()): string {
    for (const [k, v] of this.pending) if (v.expires <= at) this.pending.delete(k);
    const state = randomBytes(24).toString("base64url");
    const returnTo = `${base}${STEAM_CALLBACK}?state=${state}`;
    this.pending.set(state, { userId, returnTo, expires: at + LIFETIME_MS });
    const url = new URL(OPENID);
    for (const [k, v] of Object.entries({ ns: NS, mode: "checkid_setup", return_to: returnTo, realm: base, identity: SELECT, claimed_id: SELECT })) url.searchParams.set(`openid.${k}`, v);
    return url.toString();
  }

  /**
   * Checks what Steam sent back, with Steam itself (check_authentication), and returns whose
   * LootDen account it was for and their 17-digit Steam ID.
   */
  async finish(query: Record<string, string | undefined>, at = Date.now()): Promise<{ userId: number; steamId: string }> {
    const state = query.state ?? "";
    const entry = this.pending.get(state);
    this.pending.delete(state);
    if (!entry || entry.expires <= at) throw new Error("This Steam sign-in expired or was already used; start it again from your profile");
    if (query["openid.mode"] !== "id_res") throw new Error("Steam sign-in was cancelled");
    if (query["openid.op_endpoint"] !== OPENID) throw new Error("That answer didn't come from Steam");
    // An answer meant for another site (or another sign-in) can't be replayed here.
    if (query["openid.return_to"] !== entry.returnTo) throw new Error("That Steam answer was for a different sign-in");
    const steamId = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/.exec(query["openid.claimed_id"] ?? "")?.[1];
    if (!steamId || query["openid.identity"] !== query["openid.claimed_id"]) throw new Error("Steam didn't say which account signed in");
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (k.startsWith("openid.") && v !== undefined) body.set(k, v);
    body.set("openid.mode", "check_authentication");
    const res = await this.fetchImpl(OPENID, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok || !/(^|\n)is_valid:true(\n|$)/.test(await res.text())) throw new Error("Steam couldn't confirm the sign-in; try again");
    return { userId: entry.userId, steamId };
  }
}
