// Xbox Live for LootDen's own remote play: signing in with a Microsoft account, the consoles on
// it and what they have installed, waking a console and starting a game on it, and the xHome
// streaming service that streams a console to this PC.
//
// The requests follow Greenlight (github.com/unknownskl/greenlight) and the libraries it is built
// on, xal-node and xbox-webapi-node (all MIT, by UnknownSKL): the same public client id that
// Greenlight signs in with, the same token chain (Microsoft account, Xbox user token, XSTS
// tokens for Xbox Live and for the streaming service, the streaming service's own token) and the
// same xHome session calls. Written again here with fetch, so it runs in the desktop app's main
// process with nothing extra to install and can be tested with a fake fetch.

/** The public client id Greenlight signs in with (an Xbox app registration that allows the device code flow). */
export const XBOX_CLIENT_ID = "1f907974-e22b-4810-a9de-d9647380c97e";
const SCOPE = "xboxlive.signin openid profile offline_access";
const LOGIN = "https://login.microsoftonline.com/consumers/oauth2/v2.0";
/** What xHome asks for once the console is ready: a token that hands the stream to this account. */
const TRANSFER_SCOPE = "service::http://Passport.NET/purpose::PURPOSE_XBOX_CLOUD_CONSOLE_TRANSFER_TOKEN";
const XCCS = "https://xccs.xboxlive.com";
const XCCS_HEADERS = { "x-xbl-contract-version": "4", skillplatform: "RemoteManagement" };
const BROWSER_HEADERS = { Origin: "https://www.xbox.com", Referer: "https://www.xbox.com/" };

type Fetch = typeof fetch;

/** What LootDen keeps between runs: the Microsoft account's refresh token and when it signed in. */
export interface XboxSavedSignIn {
  refreshToken: string;
  /** The access token and when it runs out, so a fresh one isn't fetched for every call. */
  accessToken?: string;
  accessExpiresAt?: number;
  gamertag?: string;
  signedInAt: string;
}

/** The code to type at microsoft.com/link, from the device code sign-in. */
export interface XboxDeviceCode {
  userCode: string;
  deviceCode: string;
  verificationUri: string;
  /** Seconds until the code runs out. */
  expiresIn: number;
  /** Seconds to wait between checks. */
  interval: number;
}

export interface XboxConsole {
  id: string;
  name: string;
  /** "XboxSeriesX", "XboxSeriesS", "XboxOne", "XboxOneX"... */
  consoleType: string;
  /** "On", "ConnectedStandby" (asleep, can be woken), "Off". */
  powerState: string;
  /** Remote features are on, so it can be streamed and woken. */
  streamingEnabled: boolean;
  remoteManagementEnabled: boolean;
}

export interface XboxInstalledGame {
  titleId: string;
  name: string;
  /** The Microsoft Store id, which starts the game on the console; missing for some older games. */
  productId: string | null;
  sizeBytes: number;
  lastActiveTime: string | null;
}

/** An error the person can act on: signed out, remote features off, the console not found... */
export class XboxLiveError extends Error {
  constructor(
    message: string,
    readonly code: "signed-out" | "pending" | "expired" | "declined" | "xbox" | "network",
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Xbox Live's own explanations for the XSTS refusals people actually run into. */
const XSTS_ERRORS: Record<string, string> = {
  "2148916233": "This Microsoft account has no Xbox profile yet. Sign in on xbox.com once to make one, then sign in here again",
  "2148916235": "Xbox Live isn't available in this account's country",
  "2148916236": "This account needs adult verification on xbox.com first",
  "2148916237": "This account needs adult verification on xbox.com first",
  "2148916238": "This is a child account: a parent has to add it to a Microsoft family and allow it to sign in",
};

async function body<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    return { raw: text } as T;
  }
}

/**
 * A Microsoft account signed in for Xbox, with every token remote play needs made (and made
 * again) from its refresh token. save() gets the new refresh token each time Microsoft hands
 * out one, which LootDen keeps sealed on this PC.
 */
export class XboxLive {
  private xstsUser: { token: string; expires: number } | null = null;
  private xsts = new Map<string, { token: string; uhs: string; expires: number; xuid?: string; gamertag?: string }>();
  private stream: { token: string; baseUri: string; expires: number } | null = null;

  constructor(
    private saved: XboxSavedSignIn | null,
    private readonly save: (s: XboxSavedSignIn | null) => void,
    private readonly fetchImpl: Fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  get signedIn(): boolean {
    return !!this.saved?.refreshToken;
  }

  get gamertag(): string | null {
    return this.saved?.gamertag ?? null;
  }

  // ---- Signing in ------------------------------------------------------------------------

  /** Starts a sign-in: the person types the code at the address it gives, on any device. */
  async startSignIn(): Promise<XboxDeviceCode> {
    const res = await this.fetchImpl(`${LOGIN}/devicecode`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: XBOX_CLIENT_ID, scope: SCOPE }).toString(),
    });
    const b = await body<{ user_code?: string; device_code?: string; verification_uri?: string; expires_in?: number; interval?: number; error_description?: string }>(res);
    if (!res.ok || !b.user_code || !b.device_code) throw new XboxLiveError(`Microsoft didn't start the sign-in (${b.error_description ?? res.status})`, "network", res.status);
    return { userCode: b.user_code, deviceCode: b.device_code, verificationUri: b.verification_uri ?? "https://microsoft.com/link", expiresIn: b.expires_in ?? 900, interval: b.interval ?? 5 };
  }

  /**
   * Checks once whether the person has entered the code. Throws XboxLiveError "pending" until
   * they have, "expired" once the code runs out and "declined" if they said no.
   */
  async finishSignIn(deviceCode: string): Promise<void> {
    const res = await this.fetchImpl(`${LOGIN}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: XBOX_CLIENT_ID, device_code: deviceCode }).toString(),
    });
    const b = await body<{ access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string }>(res);
    if (b.error === "authorization_pending" || b.error === "slow_down") throw new XboxLiveError("Waiting for the code to be entered", "pending");
    if (b.error === "expired_token") throw new XboxLiveError("The code ran out. Start the sign-in again", "expired");
    if (b.error === "authorization_declined" || b.error === "access_denied") throw new XboxLiveError("The sign-in was declined", "declined");
    if (!res.ok || !b.access_token || !b.refresh_token) throw new XboxLiveError(`Microsoft didn't finish the sign-in (${b.error_description ?? res.status})`, "network", res.status);
    this.forgetTokens();
    this.saved = { refreshToken: b.refresh_token, accessToken: b.access_token, accessExpiresAt: this.now() + (b.expires_in ?? 3600) * 1000, signedInAt: new Date(this.now()).toISOString() };
    this.save(this.saved);
    // The gamertag, for the sign-in card; a failure here (no Xbox profile) is worth saying now.
    const web = await this.xstsToken("http://xboxlive.com");
    if (web.gamertag) {
      this.saved = { ...this.saved, gamertag: web.gamertag };
      this.save(this.saved);
    }
  }

  signOut(): void {
    this.saved = null;
    this.forgetTokens();
    this.save(null);
  }

  private forgetTokens(): void {
    this.xstsUser = null;
    this.xsts.clear();
    this.stream = null;
  }

  // ---- The token chain -------------------------------------------------------------------

  /** The Microsoft account's access token, refreshed when it's about to run out. */
  private async accessToken(): Promise<string> {
    const s = this.saved;
    if (!s?.refreshToken) throw new XboxLiveError("Sign in with your Microsoft account first", "signed-out");
    if (s.accessToken && (s.accessExpiresAt ?? 0) - this.now() > 60_000) return s.accessToken;
    const res = await this.fetchImpl(`${LOGIN}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-store" },
      body: new URLSearchParams({ client_id: XBOX_CLIENT_ID, grant_type: "refresh_token", refresh_token: s.refreshToken, scope: SCOPE }).toString(),
    });
    const b = await body<{ access_token?: string; refresh_token?: string; expires_in?: number; error_description?: string }>(res);
    if (res.status === 400 || res.status === 401) {
      // The refresh token was revoked or ran out (90 days unused): sign in again.
      this.signOut();
      throw new XboxLiveError("Microsoft signed LootDen out. Sign in with your Microsoft account again", "signed-out", res.status);
    }
    if (!res.ok || !b.access_token) throw new XboxLiveError(`Microsoft didn't renew the sign-in (${b.error_description ?? res.status})`, "network", res.status);
    this.saved = { ...s, refreshToken: b.refresh_token ?? s.refreshToken, accessToken: b.access_token, accessExpiresAt: this.now() + (b.expires_in ?? 3600) * 1000 };
    this.save(this.saved);
    return b.access_token;
  }

  /** The Xbox user token, from the Microsoft access token. */
  private async userToken(): Promise<string> {
    if (this.xstsUser && this.xstsUser.expires - this.now() > 60_000) return this.xstsUser.token;
    const access = await this.accessToken();
    const res = await this.fetchImpl("https://user.auth.xboxlive.com/user/authenticate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-xbl-contract-version": "1", "Cache-Control": "no-cache", ...BROWSER_HEADERS },
      body: JSON.stringify({ Properties: { AuthMethod: "RPS", RpsTicket: `d=${access}`, SiteName: "user.auth.xboxlive.com" }, RelyingParty: "http://auth.xboxlive.com", TokenType: "JWT" }),
    });
    const b = await body<{ Token?: string; NotAfter?: string }>(res);
    if (!res.ok || !b.Token) throw new XboxLiveError(`Xbox Live didn't accept the sign-in (${res.status})`, "xbox", res.status);
    this.xstsUser = { token: b.Token, expires: b.NotAfter ? Date.parse(b.NotAfter) : this.now() + 3600_000 };
    return b.Token;
  }

  /** An XSTS token for one Xbox Live service ("http://xboxlive.com" for the console API, gssv for streaming). */
  private async xstsToken(relyingParty: string): Promise<{ token: string; uhs: string; gamertag?: string }> {
    const cached = this.xsts.get(relyingParty);
    if (cached && cached.expires - this.now() > 60_000) return cached;
    const user = await this.userToken();
    const res = await this.fetchImpl("https://xsts.auth.xboxlive.com/xsts/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-xbl-contract-version": "1", "Cache-Control": "no-cache", ...BROWSER_HEADERS },
      body: JSON.stringify({ Properties: { SandboxId: "RETAIL", UserTokens: [user] }, RelyingParty: relyingParty, TokenType: "JWT" }),
    });
    const b = await body<{ Token?: string; NotAfter?: string; DisplayClaims?: { xui?: Array<{ uhs?: string; gtg?: string; xid?: string }> }; XErr?: number | string }>(res);
    if (res.status === 401 && b.XErr !== undefined) throw new XboxLiveError(XSTS_ERRORS[String(b.XErr)] ?? `Xbox Live refused this account (${b.XErr})`, "xbox", res.status);
    const claims = b.DisplayClaims?.xui?.[0];
    if (!res.ok || !b.Token || !claims?.uhs) throw new XboxLiveError(`Xbox Live didn't give a token (${res.status})`, "xbox", res.status);
    const t = { token: b.Token, uhs: claims.uhs, gamertag: claims.gtg, xuid: claims.xid, expires: b.NotAfter ? Date.parse(b.NotAfter) : this.now() + 3600_000 };
    this.xsts.set(relyingParty, t);
    return t;
  }

  /** The xHome streaming service's own token and the region it streams through. */
  private async streamToken(): Promise<{ token: string; baseUri: string }> {
    if (this.stream && this.stream.expires - this.now() > 60_000) return this.stream;
    const gssv = await this.xstsToken("http://gssv.xboxlive.com/");
    const res = await this.fetchImpl("https://xhome.gssv-play-prod.xboxlive.com/v2/login/user", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "x-gssv-client": "XboxComBrowser" },
      body: JSON.stringify({ token: gssv.token, offeringId: "xhome" }),
    });
    const b = await body<{ gsToken?: string; durationInSeconds?: number; offeringSettings?: { regions?: Array<{ baseUri?: string; isDefault?: boolean }> } }>(res);
    const regions = b.offeringSettings?.regions ?? [];
    const region = regions.find((r) => r.isDefault) ?? regions[0];
    if (!res.ok || !b.gsToken || !region?.baseUri) throw new XboxLiveError(`Xbox's streaming service didn't let this account in (${res.status})`, "xbox", res.status);
    this.stream = { token: b.gsToken, baseUri: region.baseUri.replace(/\/$/, ""), expires: this.now() + (b.durationInSeconds ?? 3600) * 1000 };
    return this.stream;
  }

  /** The token xHome asks for once the console is ready, which hands the stream to this account. */
  async transferToken(): Promise<string> {
    const s = this.saved;
    if (!s?.refreshToken) throw new XboxLiveError("Sign in with your Microsoft account first", "signed-out");
    const res = await this.fetchImpl("https://login.live.com/oauth20_token.srf", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: XBOX_CLIENT_ID, scope: TRANSFER_SCOPE, grant_type: "refresh_token", refresh_token: s.refreshToken }).toString(),
    });
    const b = await body<{ access_token?: string }>(res);
    if (!res.ok || !b.access_token) throw new XboxLiveError(`Microsoft didn't hand over the console (${res.status})`, "xbox", res.status);
    return b.access_token;
  }

  // ---- The consoles (Xbox's console API, the one the Xbox app uses) ---------------------

  private async xccs<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const web = await this.xstsToken("http://xboxlive.com");
    const res = await this.fetchImpl(`${XCCS}${path}`, {
      method: init.method ?? "GET",
      headers: { ...XCCS_HEADERS, Authorization: `XBL3.0 x=${web.uhs};${web.token}`, "Content-Type": "application/json", Accept: "application/json", "Accept-Language": "en-US" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const b = await body<T & { status?: { errorCode?: string; errorMessage?: string | null } }>(res);
    if (!res.ok) throw new XboxLiveError(`Xbox's console service answered ${res.status}`, "xbox", res.status);
    const code = b.status?.errorCode;
    if (code && code !== "OK") throw new XboxLiveError(b.status?.errorMessage || `Xbox's console service said ${code}`, "xbox");
    return b;
  }

  /** The consoles on this account. */
  async consoles(): Promise<XboxConsole[]> {
    const b = await this.xccs<{ result?: Array<Record<string, unknown>> }>("/lists/devices?queryCurrentDevice=false&includeStorageDevices=true");
    return (b.result ?? []).map((c) => ({
      id: String(c.id ?? ""),
      name: String(c.name ?? "Xbox"),
      consoleType: String(c.consoleType ?? ""),
      powerState: String(c.powerState ?? ""),
      streamingEnabled: c.consoleStreamingEnabled === true,
      remoteManagementEnabled: c.remoteManagementEnabled === true,
    }));
  }

  /** The games installed on a console (apps and add-ons left out), most recently played first. */
  async installedGames(consoleId: string): Promise<XboxInstalledGame[]> {
    const b = await this.xccs<{ result?: Array<Record<string, unknown>> }>(`/lists/installedApps?deviceId=${encodeURIComponent(consoleId)}`);
    const games = (b.result ?? [])
      .filter((a) => a.isGame === true || a.contentType === "Game")
      .filter((a) => a.contentType !== "Dlc" && !a.parentId)
      .map((a) => ({
        titleId: String(a.titleId ?? ""),
        name: String(a.name ?? ""),
        productId: typeof a.oneStoreProductId === "string" && a.oneStoreProductId ? a.oneStoreProductId : null,
        sizeBytes: Number(a.sizeInBytes ?? 0),
        lastActiveTime: typeof a.lastActiveTime === "string" ? a.lastActiveTime : null,
      }))
      .filter((g) => g.titleId && g.titleId !== "0" && g.name);
    return games.sort((x, y) => (y.lastActiveTime ?? "").localeCompare(x.lastActiveTime ?? "") || x.name.localeCompare(y.name));
  }

  private command(consoleId: string, type: string, command: string, parameters: Array<Record<string, string>> = [{}]) {
    return this.xccs("/commands", {
      method: "POST",
      body: { destination: "Xbox", type, command, sessionId: crypto.randomUUID(), sourceId: "com.microsoft.smartglass", parameters, linkedXboxId: consoleId },
    });
  }

  /** Wakes a console from sleep (it has to be in sleep mode, not fully off, with remote features on). */
  async wake(consoleId: string): Promise<void> {
    await this.command(consoleId, "Power", "WakeUp");
  }

  /** Starts a game on the console by its Microsoft Store id, so the stream opens in the game. */
  async launch(consoleId: string, productId: string): Promise<void> {
    await this.command(consoleId, "Shell", "ActivateApplicationWithOneStoreProductId", [{ oneStoreProductId: productId }]);
  }

  // ---- Streaming (xHome) ----------------------------------------------------------------

  /** Starts a stream session with a console; returns its id. The console has to be on or asleep. */
  async startStream(consoleId: string, opts: { locale?: string; width?: number; height?: number } = {}): Promise<XHomeSession> {
    const { token, baseUri } = await this.streamToken();
    const deviceInfo = {
      appInfo: { env: { clientAppId: "Microsoft.GamingApp", clientAppType: "native", clientAppVersion: "2203.1001.4.0", clientSdkVersion: "8.5.2", httpEnvironment: "prod", sdkInstallId: "" } },
      dev: {
        hw: { make: "Microsoft", model: "Surface Pro", sdktype: "native" },
        os: { name: "Windows 11", ver: "22631.2715", platform: "desktop" },
        displayInfo: { dimensions: { widthInPixels: opts.width ?? 1920, heightInPixels: opts.height ?? 1080 }, pixelDensity: { dpiX: 1, dpiY: 1 } },
      },
    };
    const res = await this.fetchImpl(`${baseUri}/v5/sessions/home/play`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-MS-Device-Info": JSON.stringify(deviceInfo) },
      body: JSON.stringify({
        titleId: "",
        systemUpdateGroup: "",
        clientSessionId: "",
        settings: {
          nanoVersion: "V3;WebrtcTransport.dll",
          enableTextToSpeech: false,
          highContrast: 0,
          locale: opts.locale ?? "en-US",
          useIceConnection: false,
          timezoneOffsetMinutes: -new Date(this.now()).getTimezoneOffset(),
          sdkType: "web",
          osName: "windows",
        },
        serverId: consoleId,
        fallbackRegionNames: [],
      }),
    });
    const b = await body<{ sessionPath?: string }>(res);
    if (!res.ok || !b.sessionPath) throw new XboxLiveError(`Xbox didn't start the stream (${res.status})`, "xbox", res.status);
    const id = b.sessionPath.split("/").filter(Boolean).pop()!;
    return new XHomeSession(id, baseUri, token, this, this.fetchImpl);
  }
}

/** What a stream session is doing, as xHome reports it. */
export type XHomeState = "Provisioning" | "ReadyToConnect" | "Provisioned" | "WaitingForResources" | "Failed" | string;

/** One stream with a console: its state, the connection handshake, keepalives and the end. */
export class XHomeSession {
  constructor(
    readonly id: string,
    private readonly baseUri: string,
    private readonly token: string,
    private readonly live: XboxLive,
    private readonly fetchImpl: Fetch,
  ) {}

  private async call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(`${this.baseUri}/v5/sessions/home/${this.id}${path}`, {
        method: init.method ?? "GET",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
      // 204: the answer isn't ready yet (the SDP and ICE answers come a moment after the offer).
      if (res.status === 204 && attempt < 40) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      const b = await body<T>(res);
      if (!res.ok) throw new XboxLiveError(`Xbox's streaming service answered ${res.status}`, "xbox", res.status);
      return b;
    }
  }

  async state(): Promise<{ state: XHomeState; error?: { code?: string; message?: string } }> {
    const b = await this.call<{ state?: string; errorDetails?: { code?: string; message?: string } }>("/state");
    return { state: b.state ?? "", error: b.errorDetails };
  }

  /** Hands the stream to this account once the session is ReadyToConnect. */
  async connect(): Promise<void> {
    await this.call("/connect", { method: "POST", body: { userToken: await this.live.transferToken() } });
  }

  /**
   * Waits until the console is ready to stream, handing it over on the way. onState hears each
   * state, for the "Waking your Xbox…" line. Throws with Xbox's own reason when it fails.
   */
  async ready(onState: (s: XHomeState) => void = () => {}, timeoutMs = 120_000, pollMs = 1000): Promise<void> {
    const until = Date.now() + timeoutMs;
    let connected = false;
    while (Date.now() < until) {
      const s = await this.state();
      onState(s.state);
      if (s.state === "Provisioned") return;
      if (s.state === "Failed") throw new XboxLiveError(streamFailure(s.error), "xbox");
      if (s.state === "ReadyToConnect" && !connected) {
        connected = true;
        await this.connect();
        continue;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new XboxLiveError("The console didn't get ready in time. Check it's on or asleep with remote features on, then try again", "xbox");
  }

  /** Sends the player's SDP offer and returns the console's answer. Chat renegotiations say so. */
  async sdp(offer: string, chat = false): Promise<string> {
    const configuration = chat
      ? { isMediaStreamsChatRenegotiation: true }
      : {
          chatConfiguration: { bytesPerSample: 2, expectedClipDurationMs: 20, format: { codec: "opus", container: "webm" }, numChannels: 1, sampleFrequencyHz: 24000 },
          chat: { minVersion: 1, maxVersion: 1 },
          control: { minVersion: 1, maxVersion: 3 },
          input: { minVersion: 1, maxVersion: 8 },
          message: { minVersion: 1, maxVersion: 1 },
        };
    await this.call("/sdp", { method: "POST", body: { messageType: "offer", sdp: offer, configuration } });
    const answer = await this.call<{ exchangeResponse?: string }>("/sdp");
    const parsed = JSON.parse(answer.exchangeResponse ?? "{}") as { sdp?: string; status?: string };
    if (!parsed.sdp) throw new XboxLiveError("The console didn't answer the connection offer", "xbox");
    return parsed.sdp;
  }

  /** Sends the player's ICE candidates and returns the console's, with its Teredo address spelled out. */
  async ice(candidates: Array<{ candidate: string; sdpMLineIndex: number | null; sdpMid: string | null }>): Promise<Array<{ candidate: string; sdpMLineIndex: string | number; sdpMid: string }>> {
    await this.call("/ice", { method: "POST", body: { messageType: "iceCandidate", candidate: candidates } });
    const answer = await this.call<{ exchangeResponse?: string }>("/ice");
    return withTeredo(JSON.parse(answer.exchangeResponse ?? "[]") as Array<{ candidate: string; sdpMLineIndex: string | number; sdpMid: string }>);
  }

  keepalive(): Promise<unknown> {
    return this.call("/keepalive", { method: "POST" });
  }

  async stop(): Promise<void> {
    await this.call("", { method: "DELETE" }).catch(() => {});
  }
}

/** Xbox's reason for a failed stream, in words the person can act on. */
export function streamFailure(error?: { code?: string; message?: string }): string {
  const text = `${error?.code ?? ""} ${error?.message ?? ""}`;
  if (/WaitingForServerToRegister/i.test(text)) return "Your Xbox isn't connected to Xbox Live. Turn it on (or set it to sleep mode) with remote features on, then try again";
  if (/ConsoleNotFound|ServerNotFound/i.test(text)) return "Xbox couldn't find that console on this account";
  if (/StreamingDisabled|RemotePlayDisabled/i.test(text)) return "Remote play is off on the console: Settings, Devices & connections, Remote features";
  if (/InUse|AlreadyStreaming|Busy/i.test(text)) return "Someone is already streaming from this console";
  return `Xbox couldn't start the stream${error?.code ? ` (${error.code}${error.message ? `: ${error.message}` : ""})` : ""}`;
}

/**
 * The console often offers only a Teredo IPv6 candidate (2001:0::/32), which a browser can't
 * reach. Its real IPv4 address and port are inside it, obfuscated: Greenlight adds them as
 * plain candidates (port 9002 and the mapped one), and so does this.
 */
export function withTeredo<T extends { candidate: string; sdpMLineIndex: string | number; sdpMid: string }>(candidates: T[]): Array<T | { candidate: string; messageType: string; sdpMLineIndex: string; sdpMid: string }> {
  const out: Array<T | { candidate: string; messageType: string; sdpMLineIndex: string; sdpMid: string }> = [];
  for (const c of candidates) {
    const address = c.candidate?.split(" ")[4];
    const teredo = address ? teredoClient(address) : null;
    if (teredo) {
      out.push({ candidate: `a=candidate:10 1 UDP 1 ${teredo.ip} 9002 typ host `, messageType: "iceCandidate", sdpMLineIndex: "0", sdpMid: "0" });
      out.push({ candidate: `a=candidate:11 1 UDP 1 ${teredo.ip} ${teredo.port} typ host `, messageType: "iceCandidate", sdpMLineIndex: "0", sdpMid: "0" });
    }
    out.push(c);
  }
  return out;
}

/** The client IPv4 address and port inside a Teredo address (RFC 4380: both stored inverted). */
export function teredoClient(address: string): { ip: string; port: number } | null {
  const groups = expandIpv6(address);
  if (!groups || groups[0] !== 0x2001 || groups[1] !== 0) return null;
  const port = groups[5]! ^ 0xffff;
  const hi = groups[6]! ^ 0xffff;
  const lo = groups[7]! ^ 0xffff;
  return { ip: `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`, port };
}

function expandIpv6(address: string): number[] | null {
  const a = address.replace(/^\[|\]$/g, "").split("%")[0]!;
  if (!/^[0-9a-f:]+$/i.test(a)) return null;
  const [head, tail] = a.split("::");
  const parts = (s: string | undefined) => (s ? s.split(":").filter(Boolean) : []);
  const h = parts(head);
  const t = parts(tail);
  if (a.includes("::") ? h.length + t.length > 7 : h.length !== 8) return null;
  const groups = [...h, ...Array(8 - h.length - t.length).fill("0"), ...t].map((g) => parseInt(g, 16));
  return groups.some((g) => Number.isNaN(g) || g > 0xffff) ? null : groups;
}
