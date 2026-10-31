import { useEffect, useRef } from "react";

/**
 * Closes a pop-up on Esc, and so on a controller's B (the gamepad code sends Esc to whatever
 * pop-up is open, see gamepad.ts). Off while `active` is false.
 */
export function useEscape(onEscape: () => void, active = true): void {
  const latest = useRef(onEscape);
  latest.current = onEscape;
  useEffect(() => {
    if (!active) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      latest.current();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [active]);
}
