import { useEffect, useRef, useState } from "react";
import type { GameInfo, GameManual } from "@lootden/shared";
import { api } from "../api";
import { t } from "../i18n";

/** The game's manuals: PDFs that came with it, or one an admin uploaded. Opens them over the page. */
export function ManualsPanel({ gameId, title }: { gameId: string; title: string }) {
  const [manuals, setManuals] = useState<GameManual[] | null>(null);
  const [open, setOpen] = useState<GameManual | null>(null);
  useEffect(() => {
    let live = true;
    api.manuals(gameId).then((m) => live && setManuals(m), () => live && setManuals([]));
    return () => {
      live = false;
    };
  }, [gameId]);
  if (!manuals?.length) return null;
  return (
    <section className="panel manuals">
      <h2>{t("Manual")}</h2>
      <div className="manual-list">
        {manuals.map((m) => (
          <button key={m.url} className="secondary" onClick={() => setOpen(m)}>
            📖 {manuals.length === 1 ? t("Read the manual") : m.name}
          </button>
        ))}
      </div>
      {open && <ManualViewer manual={open} title={title} onClose={() => setOpen(null)} />}
    </section>
  );
}

/** Full-screen PDF reader (the browser's own viewer). B or Esc closes it. */
function ManualViewer({ manual, title, onClose }: { manual: GameManual; title: string; onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="manual-viewer" role="dialog" aria-label={`${title}: ${manual.name}`}>
      <div className="manual-bar">
        <strong>
          {title} · {manual.name}
        </strong>
        <a className="button ghost" href={manual.url} target="_blank" rel="noreferrer">
          {t("Open in a new tab")}
        </a>
        <button ref={close} className="secondary" onClick={onClose}>
          {t("Close")}
        </button>
      </div>
      <iframe src={manual.url} title={manual.name} />
    </div>
  );
}

/** Admin: upload or remove a manual, e.g. a scan for an emulated game. */
export function ManualAdmin({ gameId }: { gameId: string }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setNote(null);
    try {
      await api.uploadManual(gameId, file);
      setNote(t("Manual saved."));
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel">
      <h2>{t("Manual")}</h2>
      <p className="muted small">{t("PDFs in the game's own files show up by themselves. Upload one here for games that don't come with it.")}</p>
      <div className="row-actions">
        <label className="button secondary">
          {busy ? t("Uploading…") : t("Upload a PDF")}
          <input type="file" accept="application/pdf,.pdf" hidden disabled={busy} onChange={(e) => void pick(e.target.files?.[0])} />
        </label>
        <button
          className="ghost"
          disabled={busy}
          onClick={() =>
            void api.removeManual(gameId).then(
              () => setNote(t("Uploaded manual removed.")),
              (e: Error) => setNote(e.message),
            )
          }
        >
          {t("Remove the uploaded one")}
        </button>
      </div>
      {note && <p className="muted small">{note}</p>}
    </section>
  );
}

/** Plays a trailer: a video file directly, or YouTube's player. muted+autoplay for previews. */
export function TrailerVideo({ trailer, title, preview = false, onEnded }: { trailer: NonNullable<GameInfo["trailer"]>; title: string; preview?: boolean; onEnded?: () => void }) {
  if ("youtubeId" in trailer) {
    const q = preview ? `autoplay=1&mute=1&controls=0&playsinline=1&loop=1&playlist=${trailer.youtubeId}&rel=0` : "rel=0";
    return <iframe src={`https://www.youtube-nocookie.com/embed/${trailer.youtubeId}?${q}`} title={`${title} trailer`} allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen={!preview} />;
  }
  return preview ? (
    <video src={trailer.url} poster={trailer.poster ?? undefined} autoPlay muted playsInline loop={!onEnded} onEnded={onEnded} />
  ) : (
    <video src={trailer.url} poster={trailer.poster ?? undefined} controls preload="none" />
  );
}

/** The game's trailer on its page, when Steam, IGDB or RAWG has one. */
export function TrailerPanel({ gameId, title }: { gameId: string; title: string }) {
  const [trailer, setTrailer] = useState<GameInfo["trailer"]>(null);
  useEffect(() => {
    let live = true;
    void previewFor(gameId).then((tr) => live && setTrailer(tr));
    return () => {
      live = false;
    };
  }, [gameId]);
  if (!trailer) return null;
  return (
    <section className="row">
      <h2>{t("Trailer")}</h2>
      <div className="video-frame trailer">
        <TrailerVideo trailer={trailer} title={title} />
      </div>
    </section>
  );
}

const previewCache = new Map<string, Promise<GameInfo["trailer"]>>();

/** One request per game per page load, shared by the card, the page and attract mode. */
export function previewFor(gameId: string): Promise<GameInfo["trailer"]> {
  let p = previewCache.get(gameId);
  if (!p) {
    p = api.preview(gameId).then(
      (r) => r.trailer,
      () => null,
    );
    previewCache.set(gameId, p);
  }
  return p;
}
