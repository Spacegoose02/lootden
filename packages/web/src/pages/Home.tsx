import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { GameListing } from "@lootden/shared";
import { api, type HomeData, type NewsItem, type Video } from "../api";
import { useAuth } from "../auth";
import { Badges } from "../components/Badges";
import { Cover } from "../components/Cover";
import { GameRow } from "../components/GameCard";
import { ListingRow } from "../components/Listing";
import { VideoRow } from "../components/Videos";
import { StoreGameCard, storeKey, useStoreGames } from "../components/StoreGameCard";

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
  // Games played lately on connected stores (Steam, Xbox...), next to the LootDen ones.
  const store = useStoreGames();
  const storeRecent = (store.games ?? []).filter((g) => g.lastPlayedAt).sort((a, b) => Date.parse(b.lastPlayedAt!) - Date.parse(a.lastPlayedAt!)).slice(0, 20);

  useEffect(() => {
    api.home().then(setData, (e: Error) => setError(e.message));
    // The extras are optional: a failing feed or missing key just leaves its row out.
    api.news().then((r) => setNews(r.items.slice(0, 4)), () => {});
    if (!kid) {
      api.videos().then((r) => setVideos(r.groups.filter((g) => g.videos.length)), () => {});
      api.calendar(60).then((r) => setUpcoming(r.items.filter((i) => i.releaseDate).slice(0, 20)), () => {});
    }
  }, [kid]);
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

  // Library rows first, with the extras slotted between them so the page alternates.
  const blocks: ReactNode[] = [row(take("continue"))];
  if (storeRecent.length)
    blocks.push(
      <section className="row" key="stores">
        <div className="row-head">
          <h2>Recently played on your other stores</h2>
          <Link to="/library?tab=stores" className="muted small">
            All store games
          </Link>
        </div>
        <div className="row-track">
          {storeRecent.map((g) => (
            <StoreGameCard key={storeKey(g)} game={g} local={store.installed.get(storeKey(g))} />
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

  return (
    <>
      {hero && (
        <section className="hero">
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
