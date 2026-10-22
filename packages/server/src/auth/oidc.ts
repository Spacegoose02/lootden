import { randomBytes } from "node:crypto";
import * as client from "openid-client";
import type { ServerConfig } from "../config.js";
import type { UserRecord, UserRepo } from "../users/repo.js";

interface Pending {
  verifier: string;
  returnTo: string;
  /** Set when the desktop app started the login in the system browser. */
  appNonce?: string;
  expires: number;
}

interface Handoff {
  userId: number;
  appNonce: string;
  returnTo: string;
  expires: number;
}

/** What the desktop app sends to prove a handoff code is for the login it started. */
export const isAppNonce = (s: unknown): s is string => typeof s === "string" && /^[\w-]{22,128}$/.test(s);

/**
 * Authorization-code login with PKCE against any OpenID Connect provider
 * (TinyAuth, Authelia, Authentik, Keycloak, Pocket ID, Google ...).
 */
export class OidcService {
  private configPromise: Promise<client.Configuration> | null = null;
  private pending = new Map<string, Pending>();
  private handoffs = new Map<string, Handoff>();

  constructor(
    private readonly config: ServerConfig,
    private readonly users: UserRepo,
  ) {}

  /** Forgets the discovered provider, after its settings change. */
  reset(): void {
    this.configPromise = null;
    this.pending.clear();
    this.handoffs.clear();
  }

  /** Fetches the provider's discovery document, for the Test button. */
  async test(): Promise<string> {
    this.reset();
    const cfg = await this.discover();
    return `Found ${cfg.serverMetadata().issuer}`;
  }

  get enabled(): boolean {
    const o = this.config.oidc;
    return !!(o.issuer && o.clientId && this.config.publicUrl);
  }

  get redirectUri(): string {
    return `${this.config.publicUrl}/api/auth/oidc/callback`;
  }

  private discover(): Promise<client.Configuration> {
    const o = this.config.oidc;
    this.configPromise ??= client
      .discovery(new URL(o.issuer), o.clientId, o.clientSecret || undefined, o.clientSecret ? undefined : client.None(), {
        execute: new URL(o.issuer).protocol === "http:" ? [client.allowInsecureRequests] : [],
      })
      .catch((err) => {
        this.configPromise = null; // retry discovery next time
        throw err;
      });
    return this.configPromise;
  }

  async start(returnTo = "/", appNonce?: string): Promise<string> {
    const cfg = await this.discover();
    const verifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const now = Date.now();
    for (const [k, v] of this.pending) if (v.expires < now) this.pending.delete(k);
    this.pending.set(state, { verifier, returnTo: safeReturn(returnTo), appNonce, expires: now + 10 * 60_000 });
    return client
      .buildAuthorizationUrl(cfg, {
        redirect_uri: this.redirectUri,
        scope: this.config.oidc.scopes,
        state,
        code_challenge: await client.calculatePKCECodeChallenge(verifier),
        code_challenge_method: "S256",
      })
      .toString();
  }

  /** Finishes the login and returns the local account (created on first login when allowed). */
  async finish(callbackUrl: URL): Promise<{ user: UserRecord; returnTo: string; appNonce?: string }> {
    const cfg = await this.discover();
    const state = callbackUrl.searchParams.get("state") ?? "";
    const pending = this.pending.get(state);
    this.pending.delete(state);
    if (!pending || pending.expires < Date.now()) throw new Error("Login expired or was started elsewhere; try again");
    const tokens = await client.authorizationCodeGrant(cfg, callbackUrl, { pkceCodeVerifier: pending.verifier, expectedState: state });
    let claims: Record<string, unknown> = { ...(tokens.claims() ?? {}) };
    if (tokens.access_token && claims.sub) {
      try {
        claims = { ...claims, ...(await client.fetchUserInfo(cfg, tokens.access_token, claims.sub as string)) };
      } catch {
        // Some providers have no userinfo endpoint; the ID token claims are enough.
      }
    }
    return { user: await this.provision(claims), returnTo: pending.returnTo, appNonce: pending.appNonce };
  }

  /**
   * The desktop app signs in through the system browser, since Google and others refuse
   * embedded browsers. The browser gets a one-time code to pass back to the app.
   */
  issueHandoff(userId: number, appNonce: string, returnTo: string): string {
    const now = Date.now();
    for (const [k, v] of this.handoffs) if (v.expires < now) this.handoffs.delete(k);
    const code = randomBytes(32).toString("base64url");
    this.handoffs.set(code, { userId, appNonce, returnTo, expires: now + 2 * 60_000 });
    return code;
  }

  /** Redeems a handoff code once; only the app that started the login knows its nonce. */
  redeemHandoff(code: string, appNonce: string): { userId: number; returnTo: string } | null {
    const h = this.handoffs.get(code);
    this.handoffs.delete(code);
    if (!h || h.expires < Date.now() || h.appNonce !== appNonce) return null;
    return { userId: h.userId, returnTo: h.returnTo };
  }

  private async provision(claims: Record<string, unknown>): Promise<UserRecord> {
    const sub = String(claims.sub ?? "");
    if (!sub) throw new Error("The identity provider returned no subject");
    const email = typeof claims.email === "string" ? claims.email : null;
    const preferred = String(claims.preferred_username ?? claims.nickname ?? email?.split("@")[0] ?? sub);
    const groups = Array.isArray(claims.groups) ? claims.groups.map(String) : [];
    const isAdmin = !!this.config.oidc.adminGroup && groups.includes(this.config.oidc.adminGroup);

    let user = this.users.byOidcSubject(sub);
    if (!user) {
      // Link to an existing local account with the same email, unless the provider says it's unverified.
      // Never by username: anyone can pick "admin" as a nickname (or an admin@ address) at many providers.
      const existing = email && claims.email_verified !== false && claims.email_verified !== "false" ? this.users.byEmail(email) : undefined;
      if (existing) user = await this.users.update(existing.id, { oidcSubject: sub });
    }
    if (!user) {
      if (!this.config.oidc.autoCreate) throw new Error("No account for this login; ask an admin to create one");
      const username = preferred.replace(/[^\w.@-]/g, "_");
      if (this.users.byUsername(username)) {
        throw new Error(`There's already an account named ${username}; an admin can link it by giving it the email you sign in with`);
      }
      user = await this.users.create({
        username,
        displayName: String(claims.name ?? preferred),
        email,
        role: isAdmin || this.users.count() === 0 ? "admin" : "user",
        oidcSubject: sub,
      });
    } else if (isAdmin && user.role !== "admin") {
      user = await this.users.update(user.id, { role: "admin" });
    }
    return user;
  }
}

/** Only paths on this server; "//host" would leave it. */
function safeReturn(returnTo: string): string {
  return returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/";
}
