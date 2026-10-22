import { execFile } from "node:child_process";

/** Keys and their string values, from `reg query <key> /s` output. */
export function parseRegQuery(out: string): Map<string, Record<string, string>> {
  const keys = new Map<string, Record<string, string>>();
  let current: Record<string, string> | null = null;
  for (const line of out.split(/\r?\n/)) {
    if (/^HKEY_/.test(line)) {
      current = {};
      keys.set(line.trim(), current);
      continue;
    }
    const m = line.match(/^\s+(.+?)\s+REG_(?:SZ|EXPAND_SZ|DWORD)\s+(.*)$/);
    if (m && current) current[m[1]!] = m[2]!.trim();
  }
  return keys;
}

/** Runs `reg query` (Windows only); empty when the key doesn't exist. */
export function regQuery(key: string, recursive = true): Promise<Map<string, Record<string, string>>> {
  return new Promise((resolve) =>
    execFile("reg", ["query", key, ...(recursive ? ["/s"] : [])], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, out) => resolve(err ? new Map() : parseRegQuery(out))),
  );
}
