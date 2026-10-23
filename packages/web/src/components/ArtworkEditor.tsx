import { useRef, useState } from "react";
import type { GameDetail } from "@lootden/shared";
import { api, type ArtworkOption } from "../api";

const LABEL = { cover: "Cover", background: "Background" } as const;

type Kind = "cover" | "background";

/** What the picker changes: a library game (admins) or a person's store game. */
export interface ArtworkTarget {
  current: Record<Kind, string | null>;
  /** A custom image is set (and Reset shows). */
  custom: Record<Kind, boolean>;
  options(kind: Kind, query: string): Promise<ArtworkOption[]>;
  setUrl(kind: Kind, url: string): Promise<void>;
  upload(kind: Kind, file: File): Promise<void>;
  reset(kind: Kind): Promise<void>;
}

/** Admin: replace a game's cover or background with an upload, a URL, or SteamGridDB art. */
export function ArtworkEditor({ game, onChange }: { game: GameDetail; onChange: (g: GameDetail) => void }) {
  return (
    <ArtworkPicker
      target={{
        current: { cover: game.coverUrl, background: game.backgroundUrl },
        custom: { cover: !!game.overrides.cover, background: !!game.overrides.background },
        options: (kind, q) => api.artworkOptions(game.id, kind, q),
        setUrl: async (kind, url) => onChange(await api.setArtworkUrl(game.id, kind, url)),
        upload: async (kind, file) => onChange(await api.uploadArtwork(game.id, kind, file)),
        reset: async (kind) => onChange(await api.resetArtwork(game.id, kind)),
      }}
    />
  );
}

/** Cover or background: an upload, a URL, or art found on SteamGridDB and the matched metadata. */
export function ArtworkPicker({ target, resetLabel = "Reset to metadata" }: { target: ArtworkTarget; resetLabel?: string }) {
  const [kind, setKind] = useState<"cover" | "background">("cover");
  const [options, setOptions] = useState<ArtworkOption[] | null>(null);
  const [query, setQuery] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const file = useRef<HTMLInputElement>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const apply = (fn: () => Promise<void>) => run(fn);
  const override = target.custom[kind];
  const current = target.current[kind];

  return (
    <div className="artwork">
      <h3>Artwork</h3>
      <div className="inline">
        <div className="segmented" role="tablist">
          {(["cover", "background"] as const).map((k) => (
            <button key={k} role="tab" aria-selected={kind === k} className={kind === k ? "active" : ""} onClick={() => (setKind(k), setOptions(null))}>
              {LABEL[k]}
            </button>
          ))}
        </div>
        <small className="muted">{override ? "Custom image set" : current ? "From metadata" : "None yet"}</small>
      </div>
      <div className="artwork-current">
        {current ? <img src={current} alt="" className={kind === "cover" ? "art-cover" : "art-bg"} /> : <span className="muted small">No {kind}.</span>}
      </div>
      {error && <p className="error">{error}</p>}
      <div className="inline">
        <button disabled={busy} onClick={() => file.current?.click()}>
          Upload image
        </button>
        <input
          ref={file}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void apply(() => target.upload(kind, f));
          }}
        />
        <button disabled={busy} onClick={() => run(async () => setOptions(await target.options(kind, query)))}>
          Find artwork
        </button>
        <input placeholder="Search name (optional)" value={query} onChange={(e) => setQuery(e.target.value)} style={{ width: 180 }} />
        {override && (
          <button className="ghost" disabled={busy} onClick={() => apply(() => target.reset(kind))}>
            {resetLabel}
          </button>
        )}
      </div>
      <form
        className="inline"
        onSubmit={(e) => {
          e.preventDefault();
          if (url.trim()) void apply(() => target.setUrl(kind, url.trim())).then(() => setUrl(""));
        }}
      >
        <input placeholder="…or paste an image URL" value={url} onChange={(e) => setUrl(e.target.value)} style={{ flex: 1 }} />
        <button disabled={busy || !url.trim()}>Use URL</button>
      </form>
      {options && (
        <div className={`art-options art-options-${kind}`}>
          {options.length === 0 && <p className="muted small">Nothing found. Add a SteamGridDB key in Settings, Sign-in &amp; services for many more choices.</p>}
          {options.map((o) => (
            <button key={o.url} className="art-option" disabled={busy} title={o.source} onClick={() => apply(() => target.setUrl(kind, o.url)).then(() => setOptions(null))}>
              <img src={o.thumb} alt="" loading="lazy" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
