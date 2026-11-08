import { api } from "./api";

/** Registers the service worker (installing as an app, offline start, push). Built app only. */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator) || !window.isSecureContext) return;
  window.addEventListener("load", () => void navigator.serviceWorker.register("/sw.js").catch(() => {}));
}

/** Push needs a service worker, the Push API, and (on iPhone and iPad) LootDen added to the Home Screen. */
export const pushWorks = () => typeof window !== "undefined" && window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration("/");
  return existing ?? navigator.serviceWorker.register("/sw.js");
}

export async function pushSubscription(): Promise<PushSubscription | null> {
  if (!pushWorks()) return null;
  return (await registration()).pushManager.getSubscription();
}

function keyBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Asks for permission, subscribes this device and tells the server. */
export async function turnOnPush(): Promise<void> {
  if (!pushWorks()) throw new Error("This browser can't get notifications. On an iPhone or iPad, add LootDen to the Home Screen first.");
  if ((await Notification.requestPermission()) !== "granted") throw new Error("Notifications are blocked for this site; allow them in the browser's site settings");
  const { publicKey } = await api.pushInfo();
  const reg = await registration();
  await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
  await api.pushSubscribe(sub.toJSON());
}

export async function turnOffPush(): Promise<void> {
  const sub = await pushSubscription();
  if (!sub) return;
  await api.pushUnsubscribe(sub.endpoint).catch(() => {});
  await sub.unsubscribe();
}
