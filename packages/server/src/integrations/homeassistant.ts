import { json, type Db } from "../db/database.js";
import { MqttPublisher } from "./mqtt.js";
import { readWatts } from "./power.js";

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
  /** Buttons and switches in Home Assistant: pause a kid's games, give bonus time, wake or stop a PC. */
  controls: boolean;
  /** Smart plugs: per PC, the MQTT topic its plug reports power on, and the JSON field with the watts ("" when the message is just the number). */
  power: Record<string, { topic: string; field: string }>;
}

/** What Home Assistant's buttons and switches do. */
export interface HouseActions {
  pause(userId: number, paused: boolean): void;
  bonus(userId: number, minutes: number): void;
  wake(pc: string): Promise<unknown>;
  stop(pc: string): void;
  power(pc: string, watts: number): void;
}

const DEFAULTS: HomeAssistantSettings = { enabled: false, url: "", username: "", password: "", prefix: "lootden", discovery: "homeassistant", controls: true, power: {} };

/** What Home Assistant gets: who's playing what, and a few household numbers. */
export interface HouseState {
  people: Array<{ id: number; name: string; kid: boolean; paused: boolean; playing: { title: string; device: string; startedAt: string; remainingMinutes: number | null; picture: string | null } | null }>;
  games: number;
  pcsOnline: number;
  downloads: number;
  pcs: Array<{ name: string; online: boolean; watts: number | null; kwhToday: number | null }>;
}

/** Smart plug settings as saved: PCs with a topic, without wildcards. */
function cleanPower(raw: unknown): HomeAssistantSettings["power"] {
  const out: HomeAssistantSettings["power"] = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [pc, v] of Object.entries(raw as Record<string, { topic?: unknown; field?: unknown }>)) {
    const topic = String(v?.topic ?? "").trim().slice(0, 200);
    if (!topic || /[#+]/.test(topic)) continue;
    out[pc.slice(0, 100)] = { topic, field: String(v?.field ?? "").trim().slice(0, 60) };
  }
  return out;
}

export const topicSafe = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "lootden";

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
  /** Set by the app: what the buttons and switches do. */
  actions: HouseActions | null = null;

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
      controls: patch.controls === undefined ? cur.controls : !!patch.controls,
      power: patch.power === undefined ? cur.power : cleanPower(patch.power),
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
    client.onMessage = (topic, payload) => this.onMessage(topic, payload);
    client.subscribe([...(s.controls ? [`${s.prefix}/cmd/#`] : []), ...Object.values(s.power).map((p) => p.topic)]);
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

  /** A message from Home Assistant (a button or switch) or from a PC's smart plug. */
  onMessage(topic: string, payload: string): void {
    const s = this.settings();
    const a = this.actions;
    if (!a) return;
    for (const [pc, p] of Object.entries(s.power)) {
      if (p.topic !== topic) continue;
      const w = readWatts(payload, p.field);
      if (w !== null) a.power(pc, w);
    }
    if (!s.controls || !topic.startsWith(`${s.prefix}/cmd/`)) return;
    const [kind, id, what] = topic.slice(s.prefix.length + 5).split("/");
    const st = this.state();
    if (kind === "kid") {
      const person = st.people.find((p) => String(p.id) === id && p.kid);
      if (!person) return;
      if (what === "games") a.pause(person.id, payload.trim().toUpperCase() === "OFF");
      if (what === "bonus") a.bonus(person.id, 30);
      this.changed();
    }
    if (kind === "pc") {
      const pc = st.pcs.find((p) => topicSafe(p.name) === id);
      if (!pc) return;
      if (what === "wake") void a.wake(pc.name).catch(() => {});
      if (what === "stop") a.stop(pc.name);
    }
  }

  private sensor(id: string, config: Record<string, unknown>, component = "sensor"): void {
    const s = this.settings();
    if (this.announced.has(`${component}/${id}`)) return;
    this.announced.add(`${component}/${id}`);
    const device = { identifiers: [`lootden_${s.prefix}`], name: "LootDen", manufacturer: "LootDen", configuration_url: this.publicUrl() || undefined };
    this.client!.publish(
      `${s.discovery}/${component}/${s.prefix}/${id}/config`,
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
      if (s.controls) {
        for (const p of st.people.filter((x) => x.kid)) {
          const base = `${s.prefix}/cmd/kid/${p.id}`;
          this.sensor(`games_allowed_${p.id}`, { name: `${p.name} games allowed`, icon: "mdi:gamepad-variant-outline", command_topic: `${base}/games`, state_topic: `${s.prefix}/people/${p.id}/allowed` }, "switch");
          c.publish(`${s.prefix}/people/${p.id}/allowed`, p.paused ? "OFF" : "ON", true);
          this.sensor(`bonus_${p.id}`, { name: `Give ${p.name} 30 minutes`, icon: "mdi:timer-plus-outline", command_topic: `${base}/bonus`, payload_press: "PRESS" }, "button");
        }
        for (const pc of st.pcs) {
          const slug = topicSafe(pc.name);
          this.sensor(`wake_${slug}`, { name: `Wake ${pc.name}`, icon: "mdi:power", command_topic: `${s.prefix}/cmd/pc/${slug}/wake`, payload_press: "PRESS" }, "button");
          this.sensor(`stop_${slug}`, { name: `Close the game on ${pc.name}`, icon: "mdi:stop-circle-outline", command_topic: `${s.prefix}/cmd/pc/${slug}/stop`, payload_press: "PRESS" }, "button");
        }
      }
      for (const pc of st.pcs) {
        if (!s.power[pc.name]) continue;
        const slug = topicSafe(pc.name);
        this.sensor(`power_${slug}`, { name: `${pc.name} power`, device_class: "power", unit_of_measurement: "W", state_class: "measurement", state_topic: `${s.prefix}/pcs/${slug}/power` });
        this.sensor(`energy_${slug}`, { name: `${pc.name} energy today`, device_class: "energy", unit_of_measurement: "kWh", state_class: "total_increasing", state_topic: `${s.prefix}/pcs/${slug}/energy` });
        if (pc.watts !== null) c.publish(`${s.prefix}/pcs/${slug}/power`, String(Math.round(pc.watts)), true);
        if (pc.kwhToday !== null) c.publish(`${s.prefix}/pcs/${slug}/energy`, String(pc.kwhToday), true);
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
