import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { GameListing, GameSummary } from "@lootden/shared";
import { api, formatPlaytime, type HomeData, type NewsItem, type Video } from "../api";
import { useLive } from "../live";
import { useAuth } from "../auth";
import { Badges } from "../components/Badges";
import { Cover } from "../components/Cover";
import { GameCard, GameRow } from "../components/GameCard";
import { stub } from "../components/InstalledGames";
import { ListingRow } from "../components/Listing";
import { VideoRow } from "../components/Videos";
import { StoreGameCard, storeKey, useStoreGames } from "../components/StoreGameCard";
import { bridgeError, desktop, type InstalledGame } from "../desktop";
import { usePosterSize } from "../theme";
import { PlayTimeCard } from "../components/PlayTime";
import { NowPlayingStrip, NextGameNight } from "../components/NowPlaying";
import { HomeScreenshots } from "./Screenshots";
import { WeekStrip } from "../components/Family";
import { GameOfTheDay } from "../components/Roulette";
import { HomeShelves } from "../components/Shelves";

const NOTES: Record<string, string> = {
  setup:
    "These are still installers or disc images. Install one once in the Windows app (Run installer, then Upload installed game) and everyone after you gets a ready-to-play download.",
};

/** The home page: featured games, then library rows mixed with news, videos and upcoming releases. */
export function Home() {
  const { me } = useAuth();
  const kid = !!me?.user?.kidMode;
  const [data, setData] = useState<HomeData | null>(null);
  const [news, setNews] = useState<NewsItem[]>([]);
  const [videos, setVideos] = useState<Array<{ id: string; title: string; videos: Video[] }>>([]);
  const [upcoming, setUpcoming] = useState<GameListing[]>([]);
  const [error, setError] = useState("");
  const [slide, setSlide] = useState(0);
  /** The games on this PC, in the desktop app; the Installed row shows these instead of every device's. */
  const [local, setLocal] = useState<InstalledGame[] | null>(null);
  /** Installed games that none of the home rows carry, looked up one by one so they get their real cover and details. */
  const [extra, setExtra] = useState<ReadonlyMap<string, GameSummary>>(new Map());
  const [poster] = usePosterSize();
  // Games played lately on connected stores (Steam, Xbox...), next to the LootDen ones.
  const store = useStoreGames();
  const storeRecent = (store.games ?? []).filter((g) => g.lastPlayedAt && !(desktop && store.installed.has(storeKey(g)))).sort((a, b) => Date.parse(b.lastPlayedAt!) - Date.parse(a.lastPlayedAt!)).slice(0, 20);

  // New games and freshly found covers appear without a reload.
  useLive("library", () => void api.home().then(setData, () => {}));
  useEffect(() => {
    api.home().then(setData, (e: Error) => setError(e.message));
    if (desktop) void desktop.installed().then(setLocal, () => setLocal([]));
    // The extras are optional: a failing feed or missing key just leaves its row out.
    api.news().then((r) => setNews(r.items.slice(0, 4)), () => {});
    if (!kid) {
      api.videos().then((r) => setVideos(r.groups.filter((g) => g.videos.length)), () => {});
      api.calendar(60).then((r) => setUpcoming(r.items.filter((i) => i.releaseDate).slice(0, 20)), () => {});
    }
  }, [kid]);
  useEffect(() => {
    if (!data || !local) return;
    const listed = new Set(data.sections.flatMap((s) => s.games.map((g) => g.id)));
    const missing = local.map((l) => l.gameId).filter((id) => !listed.has(id));
    if (!missing.length) return;
    let live = true;
    void Promise.allSettled(missing.map((id) => api.game(id))).then((rs) => {
      if (!live) return;
      const found = new Map<string, GameSummary>();
      for (const r of rs) if (r.status === "fulfilled") found.set(r.value.id, r.value);
      setExtra(found);
    });
    return () => {
      live = false;
    };
  }, [data, local]);
  useEffect(() => {
    if (!data?.featured.length) return;
    const t = setInterval(() => setSlide((s) => (s + 1) % data.featured.length), 8000);
    return () => clearInterval(t);
  }, [data]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  if (!data.sections.length) {
    return (
      <div className="empty">
        <h1>Your library is empty</h1>
        <p className="muted">Put games in the server's games folder (one folder per game, or one archive per game). They show up here automatically.</p>
        {!kid && (
          <p>
            <Link className="button primary" to="/discover">
              Discover games
            </Link>
          </p>
        )}
      </div>
    );
  }

  const hero = data.featured[slide % data.featured.length];
  const sections = [...data.sections];
  const take = (id: string) => {
    const i = sections.findIndex((s) => s.id === id);
    return i < 0 ? null : sections.splice(i, 1)[0]!;
  };
  const row = (s: HomeData["sections"][number] | null) => (s ? <GameRow key={s.id} title={s.title} games={s.games} note={NOTES[s.id]} /> : null);

  // Installed games straight under Featured: on this PC in the app, on any of this person's devices in a browser.
  const everyone = take("installed");
  let installed = everyone?.games ?? [];
  if (desktop && local) {
    const known = new Map(data.sections.concat(everyone ?? []).flatMap((s) => s.games).map((g) => [g.id, g]));
    const order = new Map(installed.map((g, i) => [g.id, i]));
    installed = local
      .map((l) => known.get(l.gameId) ?? extra.get(l.gameId) ?? stub(l))
      .sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity) || a.title.localeCompare(b.title));
  }
  // Store games installed on this PC sit in the same shelf, last played first.
  const storeReady = desktop ? (store.games ?? []).filter((g) => store.installed.has(storeKey(g))).sort((a, b) => (b.lastPlayedAt ?? "").localeCompare(a.lastPlayedAt ?? "") || a.title.localeCompare(b.title)) : [];
  const launchers = [...new Set([...(installed.length ? ["LootDen"] : []), ...storeReady.map((g) => g.store)])];
  // Library rows first, with the extras slotted between them so the page alternates.
  const blocks: ReactNode[] = [];
  if (installed.length || storeReady.length)
    blocks.push(
      <section className="row row-installed" key="installed">
        <div className="row-head">
          <h2>{desktop ? "Ready to play" : "Installed"}</h2>
          {desktop && launchers.length > 0 && <span className="muted small row-sub">{listOf(launchers)} on this PC</span>}
          <Link to="/library?tab=installed" className="muted small">
            All installed
          </Link>
        </div>
        <div className="row-track">
          {installed.map((g) => (
            <GameCard key={g.id} game={g} />
          ))}
          {storeReady.map((g) => (
            <StoreGameCard key={storeKey(g)} game={g} local={store.installed.get(storeKey(g))} scanned={store.scanned} />
          ))}
        </div>
      </section>,
    );
  blocks.push(<GameOfTheDay key="gotd" />);
  blocks.push(row(take("continue")));
  const together = take("together")?.games ?? [];
  if (together.length)
    blocks.push(
      <section className="row" key="together">
        <div className="row-head">
          <h2>👥 Play together</h2>
          <span className="muted small row-sub">Couch co-op, split screen and party games</span>
          <Link to="/library?tab=all&together=any" className="muted small">
            All of them
          </Link>
        </div>
        <div className="row-track">
          {together.slice(0, 20).map((g) => (
            <GameCard key={g.id} game={g} />
          ))}
        </div>
      </section>,
    );
  blocks.push(<WeekStrip key="week" />);
  blocks.push(<HomeShelves key="shelves" />);
  if (storeRecent.length)
    blocks.push(
      <section className="row" key="stores">
        <div className="row-head">
          <h2>Recently played on your other stores</h2>
          <Link to="/library?tab=all&source=stores" className="muted small">
            All store games
          </Link>
        </div>
        <div className="row-track">
          {storeRecent.map((g) => (
            <StoreGameCard key={storeKey(g)} game={g} local={store.installed.get(storeKey(g))} scanned={store.scanned} />
          ))}
        </div>
      </section>,
    );
  blocks.push(row(take("recent")));
  if (news.length) blocks.push(<NewsStrip key="news" items={news} />);
  if (videos[0]) blocks.push(<VideoRow key="v0" title={videos[0].title} videos={videos[0].videos} />);
  blocks.push(row(take("top")));
  if (upcoming.length) blocks.push(<ListingRow key="upcoming" title="Coming soon" items={upcoming} more={{ to: "/calendar", label: "Release calendar" }} />);
  blocks.push(row(take("controller")));
  for (const [i, g] of videos.slice(1).entries()) {
    blocks.push(row(sections.shift() ?? null));
    blocks.push(<VideoRow key={`v${i + 1}`} title={g.title} videos={g.videos} />);
  }
  blocks.push(...sections.map((s) => row(s)));

  const resume = data.resume && poster !== "off" ? data.resume : null;
  return (
    <>
      <PlayTimeCard compact />
      <NowPlayingStrip />
      <NextGameNight />
      {resume && <ResumeHero game={resume} installedHere={!!local?.some((l) => l.gameId === resume.id)} />}
      {!resume && hero && poster !== "off" && (
        <section className={`hero hero-${poster}`}>
          <div className={`hero-bg${hero.backgroundUrl ? " wide" : ""}`} style={hero.backgroundUrl || hero.coverUrl ? { backgroundImage: `url(${hero.backgroundUrl ?? hero.coverUrl})` } : undefined} />
          {/* Every featured game is laid out in the same spot and only the current one shows, so the
              banner is always as tall as the tallest one and the page doesn't jump when it changes. */}
          <div className="hero-slides">
            {data.featured.map((g) => {
              const on = g.id === hero.id;
              return (
                <div key={g.id} className={`hero-content${on ? " active" : ""}`} aria-hidden={!on} inert={!on}>
                  <Link to={`/games/${g.id}`} tabIndex={-1}>
                    <Cover game={g} size="hero" />
                  </Link>
                  <div>
                    <p className="eyebrow">Featured</p>
                    <h1>{g.title}</h1>
                    <p className="muted">{[g.releaseYear, g.genres.slice(0, 3).join(", ")].filter(Boolean).join(" · ")}</p>
                    <Badges game={g} />
                    {g.blurb && <p className="hero-blurb">{g.blurb.length >= 280 ? `${g.blurb.replace(/\s+\S*$/, "")}…` : g.blurb}</p>}
                    <Link to={`/games/${g.id}`} className="button primary">
                      View game
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="hero-dots">
            {data.featured.map((g, i) => (
              <button key={g.id} className={i === slide ? "dot active" : "dot"} aria-label={`Show ${g.title}`} onClick={() => setSlide(i)} />
            ))}
          </div>
        </section>
      )}
      {blocks}
      <HomeScreenshots />
    </>
  );
}

function NewsStrip({ items }: { items: NewsItem[] }) {
  return (
    <section className="row">
      <div className="row-head">
        <h2>Latest news</h2>
        <Link to="/news" className="muted small">
          All news
        </Link>
      </div>
      <div className="news-strip">
        {items.map((i) => (
          <a key={i.link + i.title} className="news-mini panel" href={i.link} target="_blank" rel="noreferrer">
            {i.image && <img src={i.image} alt="" loading="lazy" referrerPolicy="no-referrer" />}
            <span>
              <span className="eyebrow">{i.feedTitle}</span>
              <strong>{i.title}</strong>
            </span>
          </a>
        ))}
      </div>
    </section>
  );
}

const listOf = (names: string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

function lastPlayed(iso: string): string {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (days < 1) return "played today";
  if (days < 2) return "played yesterday";
  if (days < 7) return `played ${days} days ago`;
  return `played ${new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
}

/** The game played last, full width: pick up where you left off with one press. */
function ResumeHero({ game, installedHere }: { game: NonNullable<HomeData["resume"]>; installedHere: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const art = game.backgroundUrl ?? game.coverUrl;
  const play = async () => {
    setBusy(true);
    setError("");
    try {
      await desktop!.play(game.id);
    } catch (e) {
      setError(bridgeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className={`console-hero${art ? "" : " plain"}`} aria-label="Continue playing">
      {art && <div className={`console-hero-art${game.backgroundUrl ? "" : " cover"}`} style={{ backgroundImage: `url(${art})` }} />}
      <div className="console-hero-body">
        <p className="eyebrow">Continue playing</p>
        <h1>{game.title}</h1>
        <p className="console-hero-meta">{[game.playtimeSeconds >= 60 ? `${formatPlaytime(game.playtimeSeconds)} played` : null, lastPlayed(game.lastPlayedAt), game.genres.slice(0, 2).join(", ") || null].filter(Boolean).join(" · ")}</p>
        <div className="console-hero-actions">
          {desktop && installedHere ? (
            <button className="primary play-big" disabled={busy} onClick={() => void play()}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M7 4l13 8-13 8z" />
              </svg>
              {busy ? "Starting…" : "Play"}
            </button>
          ) : (
            <Link to={`/games/${game.id}`} className="button primary play-big">
              {desktop ? "Install" : "Open"}
            </Link>
          )}
          <Link to={`/games/${game.id}`} className="button glass">
            Details
          </Link>
          <Link to="/library?tab=installed" className="button glass">
            Library
          </Link>
        </div>
        {error && <p className="error small">{error}</p>}
      </div>
    </section>
  );
}
