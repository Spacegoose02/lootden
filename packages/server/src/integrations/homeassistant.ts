import { json, type Db } from "../db/database.js";
import { MqttPublisher } from "./mqtt.js";

const KEY = "homeassistant";
const MASK = "********";

export interface HomeAssistantSettings {
  enabled: boolean;
  /** mqtt://host:1883 */
  url: string;
  username: string;
  password: string;
  /** LootDen's topics start with this. */
  prefix: string;
  /** Home Assistant's discovery prefix (homeassistant unless changed). */
  discovery: string;
}

const DEFAULTS: HomeAssistantSettings = { enabled: false, url: "", username: "", password: "", prefix: "lootden", discovery: "homeassistant" };

/** What Home Assistant gets: who's playing what, and a few household numbers. */
export interface HouseState {
  people: Array<{ id: number; name: string; playing: { title: string; device: string; startedAt: string; remainingMinutes: number | null; picture: string | null } | null }>;
  games: number;
  pcsOnline: number;
  downloads: number;
}

const topicSafe = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "lootden";

/**
 * Publishes LootDen to Home Assistant over MQTT, with discovery so the sensors appear by
 * themselves: one "playing" sensor per person (the game's title, or Nothing), and how many
 * games, PCs online and downloads. Automations can then dim the lights when a game starts.
 */
export class HomeAssistantBridge {
  private client: MqttPublisher | null = null;
  private retry: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private announced = new Set<string>();
  private failures = 0;
  lastError: string | null = null;

  constructor(
    private readonly db: Db,
    private readonly state: () => HouseState,
    private readonly publicUrl: () => string,
    private readonly log: { warn: (o: object, m: string) => void } = { warn: () => {} },
    private readonly makeClient: (o: ConstructorParameters<typeof MqttPublisher>[0]) => MqttPublisher = (o) => new MqttPublisher(o),
  ) {}

  settings(): HomeAssistantSettings {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(KEY) as { value: string } | undefined;
    return { ...DEFAULTS, ...json<Partial<HomeAssistantSettings>>(row?.value ?? "{}", {}) };
  }

  view() {
    const s = this.settings();
    return { ...s, password: s.password ? MASK : "", connected: !!this.client?.connected, error: this.lastError };
  }

  async save(patch: Partial<HomeAssistantSettings>) {
    const cur = this.settings();
    const url = patch.url === undefined ? cur.url : String(patch.url).trim();
    if (url && !/^mqtts?:\/\/[^/\s]+\/?$/.test(url)) throw new Error("The broker address looks like mqtt://192.168.1.10:1883");
    const next: HomeAssistantSettings = {
      enabled: patch.enabled === undefined ? cur.enabled : !!patch.enabled,
      url,
      username: patch.username === undefined ? cur.username : String(patch.username).trim().slice(0, 100),
      password: patch.password === undefined || patch.password === MASK ? cur.password : String(patch.password).slice(0, 200),
      prefix: patch.prefix === undefined ? cur.prefix : topicSafe(String(patch.prefix)),
      discovery: patch.discovery === undefined ? cur.discovery : topicSafe(String(patch.discovery)),
    };
    if (next.enabled && !next.url) throw new Error("Add the MQTT broker's address first");
    this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(KEY, JSON.stringify(next));
    await this.restart();
    return this.view();
  }

  /** Connects (again) with the saved settings; does nothing when switched off. */
  async restart(): Promise<void> {
    this.stop();
    this.failures = 0;
    this.lastError = null;
    const s = this.settings();
    if (!s.enabled || !s.url) return;
    await this.connect().catch(() => {});
  }

  private async connect(): Promise<void> {
    const s = this.settings();
    const client = this.makeClient({
      url: s.url,
      username: s.username || undefined,
      password: s.password || undefined,
      clientId: `lootden-${topicSafe(s.prefix)}`,
      will: { topic: `${s.prefix}/status`, payload: "offline", retain: true },
      keepAliveSeconds: 60,
    });
    try {
      await client.connect(() => this.reconnectSoon());
    } catch (err) {
      this.lastError = (err as Error).message;
      this.log.warn({ err: this.lastError }, "Home Assistant (MQTT) connection failed");
      this.reconnectSoon();
      throw err;
    }
    this.client = client;
    this.failures = 0;
    this.lastError = null;
    this.announced.clear();
    client.publish(`${s.prefix}/status`, "online", true);
    this.publishAll();
  }

  private reconnectSoon(): void {
    this.client = null;
    if (this.retry || !this.settings().enabled) return;
    const wait = Math.min(300_000, 5_000 * 2 ** this.failures++);
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.connect().catch(() => {});
    }, wait);
    this.retry.unref();
  }

  /** Something changed (a game started or stopped): publish shortly, once. */
  changed(): void {
    if (!this.client || this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = null;
      this.publishAll();
    }, 1_000);
    this.debounce.unref();
  }

  private sensor(id: string, config: Record<string, unknown>): void {
    const s = this.settings();
    if (this.announced.has(id)) return;
    this.announced.add(id);
    const device = { identifiers: [`lootden_${s.prefix}`], name: "LootDen", manufacturer: "LootDen", configuration_url: this.publicUrl() || undefined };
    this.client!.publish(
      `${s.discovery}/sensor/${s.prefix}/${id}/config`,
      JSON.stringify({ unique_id: `${s.prefix}_${id}`, object_id: `${s.prefix}_${id}`, availability_topic: `${s.prefix}/status`, device, ...config }),
      true,
    );
  }

  /** Every sensor's state; also called every few minutes. */
  publishAll(): void {
    const c = this.client;
    if (!c?.connected) return;
    const s = this.settings();
    const st = this.state();
    try {
      for (const p of st.people) {
        const id = `player_${p.id}`;
        const topic = `${s.prefix}/people/${p.id}`;
        this.sensor(id, { name: `${p.name} playing`, icon: "mdi:controller", state_topic: `${topic}/state`, json_attributes_topic: `${topic}/attributes` });
        c.publish(`${topic}/state`, p.playing?.title.slice(0, 250) ?? "Nothing", true);
        const pic = p.playing?.picture && this.publicUrl() ? `${this.publicUrl().replace(/\/+$/, "")}${p.playing.picture}` : null;
        c.publish(
          `${topic}/attributes`,
          JSON.stringify({ playing: !!p.playing, device: p.playing?.device ?? null, started_at: p.playing?.startedAt ?? null, minutes_left_today: p.playing?.remainingMinutes ?? null, entity_picture: pic }),
          true,
        );
      }
      const nums: Array<[string, string, number, string]> = [
        ["games", "Games in the library", st.games, "mdi:gamepad-variant"],
        ["playing", "People playing", st.people.filter((p) => p.playing).length, "mdi:account-group"],
        ["pcs_online", "PCs online", st.pcsOnline, "mdi:desktop-tower-monitor"],
        ["downloads", "Downloads running", st.downloads, "mdi:download"],
      ];
      for (const [id, name, value, icon] of nums) {
        this.sensor(id, { name, icon, state_topic: `${s.prefix}/${id}`, state_class: "measurement" });
        c.publish(`${s.prefix}/${id}`, String(value), true);
      }
    } catch (err) {
      this.lastError = (err as Error).message;
    }
  }

  /** Sends one test message and says how it went. */
  async test(): Promise<{ ok: true }> {
    if (!this.client?.connected) await this.restart();
    if (!this.client?.connected) throw new Error(this.lastError ?? "Not connected; switch it on and check the address");
    this.publishAll();
    return { ok: true };
  }

  stop(): void {
    if (this.retry) clearTimeout(this.retry);
    if (this.debounce) clearTimeout(this.debounce);
    this.retry = this.debounce = null;
    if (this.client?.connected) {
      try {
        this.client.publish(`${this.settings().prefix}/status`, "offline", true);
      } catch {
        /* closing anyway */
      }
    }
    this.client?.close();
    this.client = null;
  }
}
