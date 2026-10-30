import { useEffect, useState } from "react";

const cache = new Map<string, string | null>();
let canvas: HTMLCanvasElement | null = null;

/**
 * The most vivid colour in a loaded image, as an rgb() string: saturated, bright pixels count
 * most, so a dark cover with a pink logo gives pink rather than brown. null when the image
 * can't be read (another site's image without CORS).
 */
export function vividColor(img: HTMLImageElement): string | null {
  const key = img.currentSrc || img.src;
  if (cache.has(key)) return cache.get(key)!;
  let result: string | null = null;
  try {
    canvas ??= document.createElement("canvas");
    canvas.width = canvas.height = 16;
    const g = canvas.getContext("2d", { willReadFrequently: true })!;
    g.drawImage(img, 0, 0, 16, 16);
    const px = g.getImageData(0, 0, 16, 16).data;
    let r = 0, gr = 0, b = 0, total = 0;
    for (let i = 0; i < px.length; i += 4) {
      const [pr, pg, pb] = [px[i]!, px[i + 1]!, px[i + 2]!];
      const max = Math.max(pr, pg, pb);
      const min = Math.min(pr, pg, pb);
      const sat = max ? (max - min) / max : 0;
      const w = (sat * (max / 255)) ** 2 + 0.002;
      r += pr * w;
      gr += pg * w;
      b += pb * w;
      total += w;
    }
    // Lift dark results so the glow still reads on a dark page.
    const [cr, cg, cb] = [r / total, gr / total, b / total];
    const lift = Math.max(1, 150 / Math.max(cr, cg, cb, 1));
    result = `rgb(${[cr, cg, cb].map((c) => Math.min(255, Math.round(c * lift))).join(" ")})`;
  } catch {
    result = null;
  }
  cache.set(key, result);
  return result;
}

/** vividColor of an image address, once it has loaded. */
export function useImageTint(url: string | null | undefined): string | null {
  const [tint, setTint] = useState<string | null>(() => (url && cache.get(url)) || null);
  useEffect(() => {
    if (!url) return setTint(null);
    if (cache.has(url)) return setTint(cache.get(url)!);
    const img = new Image();
    img.onload = () => setTint(vividColor(img));
    img.src = url;
    return () => {
      img.onload = null;
    };
  }, [url]);
  return tint;
}
