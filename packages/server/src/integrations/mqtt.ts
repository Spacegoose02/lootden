import net from "node:net";
import tls from "node:tls";

/**
 * A small MQTT 3.1.1 client that only publishes (QoS 0), enough for Home Assistant sensors:
 * connect with a user name and password, a last-will "offline" message, keep-alive pings.
 * No dependency, so LootDen's image stays the same size.
 */
export interface MqttOptions {
  /** mqtt://host:1883 or mqtts://host:8883 */
  url: string;
  username?: string;
  password?: string;
  clientId: string;
  will?: { topic: string; payload: string; retain: boolean };
  keepAliveSeconds?: number;
  /** For tests and self-signed brokers. */
  rejectUnauthorized?: boolean;
}

const str = (s: string) => {
  const b = Buffer.from(s, "utf8");
  const len = Buffer.alloc(2);
  len.writeUInt16BE(b.length);
  return Buffer.concat([len, b]);
};

/** MQTT's variable-length "remaining length". */
export function remainingLength(n: number): Buffer {
  const out: number[] = [];
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    out.push(byte);
  } while (n > 0);
  return Buffer.from(out);
}

const packet = (type: number, body: Buffer) => Buffer.concat([Buffer.from([type]), remainingLength(body.length), body]);

export function connectPacket(o: MqttOptions): Buffer {
  let flags = 0x02; // clean session
  if (o.will) flags |= 0x04 | (o.will.retain ? 0x20 : 0);
  if (o.username) flags |= 0x80;
  if (o.password) flags |= 0x40;
  const keep = Buffer.alloc(2);
  keep.writeUInt16BE(o.keepAliveSeconds ?? 60);
  const parts = [str("MQTT"), Buffer.from([4, flags]), keep, str(o.clientId)];
  if (o.will) parts.push(str(o.will.topic), str(o.will.payload));
  if (o.username) parts.push(str(o.username));
  if (o.password) parts.push(str(o.password));
  return packet(0x10, Buffer.concat(parts));
}

export function publishPacket(topic: string, payload: string, retain: boolean): Buffer {
  return packet(0x30 | (retain ? 1 : 0), Buffer.concat([str(topic), Buffer.from(payload, "utf8")]));
}

const CONNACK_ERRORS: Record<number, string> = {
  1: "the broker doesn't speak MQTT 3.1.1",
  2: "the broker refused the client id",
  3: "the broker is unavailable",
  4: "wrong user name or password",
  5: "not authorised",
};

export class MqttPublisher {
  private socket: net.Socket | null = null;
  private ping: NodeJS.Timeout | null = null;

  constructor(private readonly o: MqttOptions) {}

  get connected(): boolean {
    return !!this.socket && !this.socket.destroyed;
  }

  /** Connects and waits for the broker's answer. */
  connect(onClose?: (err: Error | null) => void): Promise<void> {
    const u = new URL(this.o.url);
    const secure = u.protocol === "mqtts:";
    if (!secure && u.protocol !== "mqtt:") return Promise.reject(new Error("The broker address starts with mqtt:// or mqtts://"));
    const port = Number(u.port) || (secure ? 8883 : 1883);
    return new Promise((resolve, reject) => {
      let settled = false;
      const sock = secure ? tls.connect({ host: u.hostname, port, servername: u.hostname, rejectUnauthorized: this.o.rejectUnauthorized ?? true }) : net.connect({ host: u.hostname, port });
      sock.setTimeout(15_000, () => sock.destroy(new Error("The broker didn't answer")));
      const fail = (err: Error) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      };
      sock.once(secure ? "secureConnect" : "connect", () => sock.write(connectPacket(this.o)));
      let buf = Buffer.alloc(0);
      sock.on("data", (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        // After CONNACK the broker only sends ping answers, which need nothing.
        if (settled) {
          buf = Buffer.alloc(0);
          return;
        }
        if (buf.length < 4) return;
        if (buf[0] !== 0x20) return fail(new Error("The broker answered something that isn't MQTT"));
        const rc = buf[3]!;
        buf = Buffer.alloc(0);
        if (rc !== 0) {
          fail(new Error(`MQTT: ${CONNACK_ERRORS[rc] ?? `refused (${rc})`}`));
          sock.destroy();
          return;
        }
        settled = true;
        sock.setTimeout(0);
        this.socket = sock;
        const every = (this.o.keepAliveSeconds ?? 60) * 500;
        this.ping = setInterval(() => sock.write(Buffer.from([0xc0, 0])), every);
        this.ping.unref();
        resolve();
      });
      sock.on("error", (err) => fail(err));
      sock.on("close", () => {
        if (this.ping) clearInterval(this.ping);
        this.ping = null;
        const was = this.socket === sock;
        if (was) this.socket = null;
        fail(new Error("The broker closed the connection"));
        if (was) onClose?.(null);
      });
    });
  }

  publish(topic: string, payload: string, retain = false): void {
    if (!this.socket || this.socket.destroyed) throw new Error("Not connected to the MQTT broker");
    this.socket.write(publishPacket(topic, payload, retain));
  }

  /** Disconnects politely (the broker doesn't send the last will). */
  close(): void {
    if (this.ping) clearInterval(this.ping);
    this.ping = null;
    const s = this.socket;
    this.socket = null;
    if (s && !s.destroyed) s.end(Buffer.from([0xe0, 0]));
  }
}
