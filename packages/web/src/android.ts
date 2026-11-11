import { desktop } from "./desktop";

/** An Android phone or handheld (Retroid Pocket, AYN Odin) using LootDen in a browser, without the app. */
export const androidBrowser = !desktop && typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);

/**
 * The couch layout (bigger type and covers, as in the desktop app's handheld mode) while a
 * controller is in use in landscape: an Android handheld's built-in controls show up as a
 * gamepad once a button is pressed. Portrait phones keep the normal layout.
 */
export function watchAndroidHandheld(): void {
  if (!androidBrowser || typeof matchMedia === "undefined") return;
  const root = document.documentElement;
  const landscape = matchMedia("(orientation: landscape)");
  const update = () => {
    const pad = Array.from(navigator.getGamepads?.() ?? []).some(Boolean);
    if (pad && landscape.matches) root.dataset.handheld = "on";
    else delete root.dataset.handheld;
  };
  window.addEventListener("gamepadconnected", update);
  window.addEventListener("gamepaddisconnected", update);
  landscape.addEventListener("change", update);
  update();
}
