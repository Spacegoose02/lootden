/** Valve's KeyValues text format (libraryfolders.vdf, appmanifest_*.acf): quoted keys, values and { } blocks. */
export type Vdf = { [key: string]: string | Vdf };

export function parseVdf(text: string): Vdf {
  const tokens: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|([{}])|\/\/[^\n]*|([^\s{}"]+)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[1] !== undefined) tokens.push(`"${m[1].replace(/\\(.)/g, "$1")}`);
    else if (m[2]) tokens.push(m[2]);
    else if (m[3]) tokens.push(`"${m[3]}`);
  }
  let i = 0;
  const block = (): Vdf => {
    const out: Vdf = {};
    while (i < tokens.length) {
      const t = tokens[i++]!;
      if (t === "}") break;
      if (t === "{") continue;
      const key = t.slice(1);
      const next = tokens[i++];
      if (next === "{") out[key] = block();
      else if (next !== undefined && next !== "}") out[key] = next.slice(1);
      else break;
    }
    return out;
  };
  return block();
}
