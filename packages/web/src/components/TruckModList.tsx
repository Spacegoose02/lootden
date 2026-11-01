import { useEffect, useMemo, useState } from "react";
import {
  matchLoadOrder,
  modFileKey,
  parseLoadOrderText,
  parseModSheet,
  TRUCK_GAMES,
  truckModFit,
  truckModTitle,
  workshopIdFromPackage,
  workshopPackage,
  type ActiveTruckMod,
  type ModLinkStatus,
  type TrackedTruckMod,
  type TrackedTruckModInput,
  type TruckGame,
  type TruckLoadOrder,
  type TruckModFile,
  type TruckModFit,
  type TruckProfile,
} from "@lootden/shared";
import { api } from "../api";
import { bridgeError, desktop, type TruckModScan } from "../desktop";

const LINK: Record<ModLinkStatus, { label: string; className: string }> = {
  unchecked: { label: "Not checked", className: "badge badge-muted" },
  live: { label: "Link works", className: "badge truck-fit-ok" },
  renamed: { label: "Renamed", className: "badge truck-fit-newer" },
  moved: { label: "Moved", className: "badge truck-fit-newer" },
  login: { label: "Sign-in page", className: "badge truck-fit-newer" },
  dead: { label: "Dead link", className: "badge truck-fit-outdated" },
  blocked: { label: "Check by hand", className: "badge badge-muted" },
};
const FIT: Record<TruckModFit, { label: string; className: string } | null> = {
  ok: { label: "Fits", className: "badge truck-fit-ok" },
  outdated: { label: "Outdated", className: "badge truck-fit-outdated" },
  newer: { label: "Needs newer game", className: "badge truck-fit-newer" },
  unknown: null,
};
const PROBLEM: ModLinkStatus[] = ["dead", "moved", "renamed", "login"];

const host = (u: string | null) => {
  try {
    return u ? new URL(u).hostname.replace(/^www\./, "") : "";
  } catch {
    return "";
  }
};
const majorMinor = (v: string | null | undefined) => String(v ?? "").match(/^(\d+\.\d+)/)?.[1] ?? null;
/** "2.4" as "v2.4"; one already starting with v (or not a number) as it is. */
const ver = (v: string) => (/^\d/.test(v) ? `v${v}` : v);
const stem = (file: string) => file.replace(/\.(scs|zip)$/i, "");

/** The game versions a tracked mod is known to be made for: its files' manifests, else what was written down. */
function madeFor(m: TrackedTruckMod, files: Map<string, TruckModFile>): string[] {
  const fromFiles = m.files.flatMap((f) => files.get(f.toLowerCase())?.manifest?.compatibleVersions ?? []);
  if (fromFiles.length) return [...new Set(fromFiles)];
  return m.gameVersion ? [m.gameVersion] : [];
}

/** The mods in a scan as list entries: one per mod (versions and copies of one mod together). */
function fromScan(scan: TruckModScan): TrackedTruckModInput[] {
  const groups = new Map<string, TruckModFile[]>();
  for (const f of scan.files) {
    const key = modFileKey(f.file) || f.file.toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  return [...groups.values()].map((files) => {
    const newest = [...files].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))[0]!;
    return {
      name: newest.manifest?.name ?? truckModTitle(newest.file),
      files: files.map((f) => f.file),
      modVersion: newest.manifest?.version ?? null,
      gameVersion: majorMinor(newest.manifest?.compatibleVersions[0]) ?? null,
    };
  });
}

/**
 * The household's mod list for ATS or ETS2: every mod with its link, versions and what the last
 * check of its page found, doubles in this PC's mod folder, and the in-game load order (read from
 * the profile, kept on the server, put back on any PC).
 */
export function TruckModListPanel({ game }: { game: TruckGame }) {
  const info = TRUCK_GAMES[game];
  const [tab, setTab] = useState<"list" | "order">("list");
  const [mods, setMods] = useState<TrackedTruckMod[] | null>(null);
  const [scan, setScan] = useState<TruckModScan | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [line, setLine] = useState("");
  const [error, setError] = useState("");
  const canLocal = !!desktop?.truckModScan;

  const load = () => api.truckModList(game).then(setMods, (e: Error) => (setMods([]), setError(e.message)));
  const rescan = () => (canLocal ? desktop!.truckModScan!(game).then(setScan, (e) => setError(bridgeError(e))) : Promise.resolve());
  useEffect(() => {
    setMods(null);
    setScan(null);
    void load();
    void rescan();
  }, [game]);
  useEffect(
    () =>
      desktop?.onProgress((p) => {
        if (p.type === "truckModCheck" && p.game === game) setLine(p.finished ? p.line : `${p.line} (${p.done + 1} of ${p.total})`);
        if (p.type === "truckMods" && p.game === game && p.done) void rescan();
      }),
    [game],
  );

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(bridgeError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="row truck-mods truck-mod-tracker">
      <div className="inline wrap" style={{ justifyContent: "space-between" }}>
        <h2>{info.short} mod list</h2>
        <div className="segmented" role="tablist" aria-label="Mod list">
          <button role="tab" aria-selected={tab === "list"} className={tab === "list" ? "active" : ""} onClick={() => setTab("list")}>
            Mods{mods ? ` (${mods.filter((m) => !m.retired).length})` : ""}
          </button>
          <button role="tab" aria-selected={tab === "order"} className={tab === "order" ? "active" : ""} onClick={() => setTab("order")}>
            Load order
          </button>
        </div>
      </div>
      {line && <p className="muted small truck-line">{line}</p>}
      {error && <p className="error small">{error}</p>}
      {tab === "list" ? (
        <ModList game={game} mods={mods} setMods={setMods} scan={scan} rescan={rescan} busy={busy} run={run} setLine={setLine} />
      ) : (
        <LoadOrder game={game} mods={mods ?? []} scan={scan} rescan={rescan} busy={busy} run={run} setLine={setLine} />
      )}
    </section>
  );
}

interface Shared {
  game: TruckGame;
  scan: TruckModScan | null;
  rescan: () => Promise<unknown>;
  busy: string | null;
  run: (key: string, fn: () => Promise<unknown>) => Promise<void>;
  setLine: (s: string) => void;
}

function ModList({ game, mods, setMods, scan, rescan, busy, run, setLine }: Shared & { mods: TrackedTruckMod[] | null; setMods: (m: TrackedTruckMod[]) => void }) {
  const [filter, setFilter] = useState<"all" | "problems" | "retired">("all");
  const [pasting, setPasting] = useState(false);
  const [paste, setPaste] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const files = useMemo(() => new Map((scan?.files ?? []).map((f) => [f.file.toLowerCase(), f])), [scan]);
  const gameVersion = scan?.gameVersion ?? null;
  const all = mods ?? [];

  const fitOf = (m: TrackedTruckMod) => truckModFit(madeFor(m, files), gameVersion);
  const missing = (m: TrackedTruckMod) => !!scan && m.files.length > 0 && !m.files.some((f) => files.has(f.toLowerCase()));
  const problem = (m: TrackedTruckMod) => !m.retired && ((m.check && PROBLEM.includes(m.check.status)) || fitOf(m) === "outdated" || missing(m));
  const shown = all.filter((m) => (filter === "retired" ? m.retired : filter === "problems" ? problem(m) : !m.retired));
  const problems = all.filter(problem).length;

  const replace = (m: TrackedTruckMod) => setMods(all.map((x) => (x.id === m.id ? m : x)));
  const patch = (m: TrackedTruckMod, p: Parameters<typeof api.updateTrackedTruckMod>[1]) => run(`m${m.id}`, async () => replace(await api.updateTrackedTruckMod(m.id, p)));

  const importPaste = () =>
    run("paste", async () => {
      const rows = parseModSheet(paste);
      if (!rows.length) throw new Error("Nothing to add: paste rows from your sheet (name, link, game version, mod version, category)");
      const r = await api.importTruckModList(game, rows);
      setMods(r.mods);
      setPaste("");
      setPasting(false);
      setLine(`Added ${r.added} mods and updated ${r.updated} already on the list`);
    });
  const importPc = () =>
    run("pc", async () => {
      const s = await desktop!.truckModScan!(game);
      let r = await api.importTruckModList(game, fromScan(s));
      let workshop = 0;
      if (s.workshop.length) {
        const w = await api.addTruckWorkshopMods(game, s.workshop.map((x) => x.id));
        workshop = w.added;
        r = { ...r, mods: w.mods };
      }
      setMods(r.mods);
      await rescan();
      setLine(`From this PC: ${r.added} new mods from the mod folder, ${workshop} from Steam Workshop; ${r.updated} already on the list`);
    });
  const checkAll = () =>
    run("check", async () => {
      let list = all;
      if (all.some((m) => m.workshopId)) list = await api.checkTruckWorkshopMods(game);
      const web = list.filter((m) => !m.retired && m.sourceUrl && !m.workshopId);
      if (desktop?.checkTruckModLinks && web.length) {
        const results = await desktop.checkTruckModLinks(game, web.map((m) => ({ id: m.id, url: m.sourceUrl!, name: m.name })));
        for (const r of results) {
          const saved = await api.updateTrackedTruckMod(r.id, { check: r.check });
          list = list.map((x) => (x.id === saved.id ? saved : x));
        }
      }
      setMods(list);
      const bad = list.filter((m) => m.check && PROBLEM.includes(m.check.status)).length;
      setLine(`Checked the links: ${bad ? `${bad} need fixing` : "they all work"}`);
    });

  if (!mods) return <p className="muted small">Loading…</p>;
  return (
    <>
      <p className="muted small">
        Every mod you use, where to get it and whether its page still works. {canCheckText(!!desktop?.checkTruckModLinks)}
        {gameVersion ? ` ${TRUCK_GAMES[game].short} ${gameVersion} on this PC.` : ""}
      </p>
      <div className="inline wrap">
        {desktop?.truckModScan && (
          <button className="small" disabled={busy !== null} onClick={() => void importPc()}>
            {busy === "pc" ? "Reading…" : "Add mods from this PC"}
          </button>
        )}
        <button className="ghost small" onClick={() => setPasting(!pasting)}>
          Paste from a spreadsheet…
        </button>
        {all.length > 0 && (
          <button className="ghost small" disabled={busy !== null} onClick={() => void checkAll()}>
            {busy === "check" ? "Checking…" : "Check links"}
          </button>
        )}
        {busy === "check" && desktop?.stopTruckModCheck && (
          <button className="ghost small" onClick={() => void desktop!.stopTruckModCheck!()}>
            Stop
          </button>
        )}
      </div>
      {pasting && (
        <div className="truck-paste">
          <textarea rows={6} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={"Copy the rows from your sheet and paste them here:\nName ⇥ Link ⇥ Game version ⇥ Mod version ⇥ Category ⇥ …"} />
          <div className="inline">
            <button className="small" disabled={busy !== null || !paste.trim()} onClick={() => void importPaste()}>
              Add to the list
            </button>
            <span className="muted small">Mods already on the list are matched by name and filled in.</span>
          </div>
        </div>
      )}

      {scan && scan.duplicates.length > 0 && <Duplicates game={game} scan={scan} rescan={rescan} busy={busy} run={run} setLine={setLine} />}

      {all.length > 0 && (
        <div className="segmented" role="radiogroup" aria-label="Show">
          {(
            [
              ["all", `All (${all.filter((m) => !m.retired).length})`],
              ["problems", `Need attention (${problems})`],
              ["retired", `Retired (${all.filter((m) => m.retired).length})`],
            ] as const
          ).map(([v, label]) => (
            <button key={v} role="radio" aria-checked={filter === v} className={filter === v ? "active" : ""} onClick={() => setFilter(v)}>
              {label}
            </button>
          ))}
        </div>
      )}
      {!all.length && <p className="muted small">No mods on the list yet. Add the ones on this PC, or paste your spreadsheet.</p>}
      <ul className="pkg-list truck-mod-list">
        {shown.map((m) =>
          editing === m.id ? (
            <EditRow key={m.id} m={m} onCancel={() => setEditing(null)} onSave={(p) => void patch(m, p).then(() => setEditing(null))} />
          ) : (
            <ModRow
              key={m.id}
              m={m}
              fit={fitOf(m)}
              versions={madeFor(m, files)}
              gameVersion={gameVersion}
              missing={missing(m)}
              busy={busy === `m${m.id}`}
              onEdit={() => setEditing(m.id)}
              onPatch={(p) => void patch(m, p)}
              onUpdate={
                desktop?.updateTruckMod && m.sourceUrl && !m.workshopId
                  ? () => void run(`m${m.id}`, () => desktop!.updateTruckMod!(game, m.check?.finalUrl ?? m.sourceUrl!, m.files.filter((f) => files.has(f.toLowerCase()))))
                  : undefined
              }
              onDelete={() => window.confirm(`Take ${m.name} off the list? Its files stay where they are.`) && void run(`m${m.id}`, async () => (await api.deleteTrackedTruckMod(m.id), setMods(all.filter((x) => x.id !== m.id))))}
            />
          ),
        )}
      </ul>
    </>
  );
}

const canCheckText = (desktopApp: boolean) =>
  desktopApp ? "Check links opens each page in a hidden browser, the way you would, so sites that turn away bots still answer." : "Open LootDen's desktop app to check the links and read this PC's mod folder; Workshop items are checked from here.";

function ModRow(props: {
  m: TrackedTruckMod;
  fit: TruckModFit;
  versions: string[];
  gameVersion: string | null;
  missing: boolean;
  busy: boolean;
  onEdit: () => void;
  onPatch: (p: Partial<TrackedTruckModInput>) => void;
  onUpdate?: () => void;
  onDelete: () => void;
}) {
  const { m, fit, versions, gameVersion, missing, busy } = props;
  const c = m.check;
  const status = c ? LINK[c.status] : m.sourceUrl ? LINK.unchecked : null;
  const f = FIT[fit];
  const pageFor = c?.latestGameVersion ?? null;
  const pageNewer = !!pageFor && !!gameVersion && majorMinor(gameVersion) === pageFor && fit !== "ok";
  const open = (url: string) => (desktop?.openBrowser ? void desktop.openBrowser(url) : window.open(url, "_blank", "noreferrer"));
  return (
    <li className={m.retired ? "truck-retired" : ""}>
      <div className="pkg-title">
        <strong>{m.name}</strong>
        {m.category && <span className="muted small">{m.category}</span>}
        {status && <span className={status.className} title={c?.note ?? undefined}>{status.label}</span>}
        {f && <span className={f.className} title={versions.length ? `Made for ${versions.join(", ")}` : undefined}>{f.label}{fit === "outdated" && versions.length ? ` (${versions.map((v) => v.replace(/\.\*$/, "")).join(", ")})` : ""}</span>}
        {pageNewer && <span className="badge truck-fit-ok">Update for {pageFor} on its page</span>}
        {missing && <span className="badge truck-fit-newer">Not on this PC</span>}
        {m.workshopId && <span className="badge badge-muted">Workshop</span>}
      </div>
      <div className="inline wrap small">
        <span className="muted">
          {[m.modVersion && ver(m.modVersion), versions.length ? `for ${versions.map((v) => v.replace(/\.\*$/, "")).join(", ")}` : null, c?.latestVersion && `page: ${ver(c.latestVersion)}`, c?.latestGameVersion && `page: for ${c.latestGameVersion}`, c?.lastUpdated && `updated ${c.lastUpdated}`, m.files.length > 0 && `${m.files.length} file${m.files.length === 1 ? "" : "s"}`]
            .filter(Boolean)
            .join(" · ")}
        </span>
        {m.sourceUrl ? (
          <button className="ghost small" onClick={() => open(m.sourceUrl!)} title={m.sourceUrl}>
            {host(m.sourceUrl) || "Mod page"}
          </button>
        ) : (
          <span className="muted">No link yet</span>
        )}
        {c?.finalUrl && (c.status === "moved" || c.status === "renamed") && (
          <button className="small" disabled={busy} onClick={() => props.onPatch({ sourceUrl: c.finalUrl })} title={c.finalUrl}>
            Use the new link
          </button>
        )}
        {c?.status === "renamed" && c.pageTitle && (
          <button className="ghost small" disabled={busy} onClick={() => props.onPatch({ name: c.pageTitle!.replace(/\s*[|\-–—]\s*(Trucky\s*Mods|SCS Software).*$/i, "").slice(0, 200) })}>
            Rename to match
          </button>
        )}
        {props.onUpdate && !m.retired && (
          <button className="small" disabled={busy} onClick={props.onUpdate} title="Opens the page in LootDen's browser; download the new version there and the old one moves to mod-old">
            Update
          </button>
        )}
        <button className="ghost small" disabled={busy} onClick={props.onEdit}>
          Edit
        </button>
        <button className="ghost small" disabled={busy} onClick={() => props.onPatch({ retired: !m.retired })}>
          {m.retired ? "Bring back" : "Retire"}
        </button>
        <button className="ghost small" disabled={busy} onClick={props.onDelete}>
          Remove
        </button>
      </div>
      {c?.note && c.status !== "live" && <p className="muted small">{c.note}</p>}
      {m.notes && <p className="muted small">{m.notes}</p>}
    </li>
  );
}

function EditRow({ m, onSave, onCancel }: { m: TrackedTruckMod; onSave: (p: Partial<TrackedTruckModInput>) => void; onCancel: () => void }) {
  const [v, setV] = useState({ name: m.name, sourceUrl: m.sourceUrl ?? "", category: m.category ?? "", gameVersion: m.gameVersion ?? "", modVersion: m.modVersion ?? "", notes: m.notes ?? "" });
  const field = (k: keyof typeof v, label: string, wide = false) => (
    <label className={`small${wide ? " truck-edit-wide" : ""}`}>
      {label}
      <input value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} />
    </label>
  );
  return (
    <li className="truck-edit">
      {field("name", "Name", true)}
      {field("sourceUrl", "Link", true)}
      {field("category", "Category")}
      {field("gameVersion", "Game version")}
      {field("modVersion", "Mod version")}
      {field("notes", "Notes", true)}
      <div className="inline">
        <button className="small" onClick={() => onSave({ ...v, sourceUrl: v.sourceUrl || null })}>
          Save
        </button>
        <button className="ghost small" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </li>
  );
}

function Duplicates({ game, scan, rescan, busy, run, setLine }: Shared & { scan: TruckModScan }) {
  const byName = new Map(scan.files.map((f) => [f.file, f]));
  const tidy = (files: string[]) => {
    const newest = [...files].sort((a, b) => (byName.get(b)?.modifiedAt ?? "").localeCompare(byName.get(a)?.modifiedAt ?? ""))[0]!;
    const old = files.filter((f) => f !== newest);
    if (!window.confirm(`Keep ${newest} and move ${old.join(", ")} to the mod-old folder?`)) return;
    void run(`dup${files[0]}`, async () => {
      const moved = await desktop!.retireTruckModFiles!(game, old);
      setLine(`Moved ${moved.length} file${moved.length === 1 ? "" : "s"} to mod-old`);
      await rescan();
    });
  };
  return (
    <details className="truck-dups" open>
      <summary>
        <span className="badge truck-fit-newer">{scan.duplicates.length} doubles</span> in the mod folder. The game loads both copies, so the older one can win.
      </summary>
      <ul className="pkg-list">
        {scan.duplicates.map((g) => (
          <li key={g.files.join("|")}>
            <div className="small">
              {g.reason === "same-file" ? "Same size, probably the same file: " : "One mod, several copies: "}
              {g.files.map((f) => (
                <code key={f} style={{ marginRight: "0.5em" }}>
                  {f}
                  {byName.get(f) ? ` (${new Date(byName.get(f)!.modifiedAt).toLocaleDateString()})` : ""}
                </code>
              ))}
            </div>
            {desktop?.retireTruckModFiles && (
              <button className="ghost small" disabled={busy !== null} onClick={() => tidy(g.files)}>
                Keep the newest, move the rest to mod-old
              </button>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

// ---- Load order --------------------------------------------------------------------------

function LoadOrder({ game, mods, scan, rescan, busy, run, setLine }: Shared & { mods: TrackedTruckMod[] }) {
  const [orders, setOrders] = useState<TruckLoadOrder[] | null>(null);
  const [profileDir, setProfileDir] = useState("");
  const [draft, setDraft] = useState<{ id: number | null; name: string; mods: ActiveTruckMod[] } | null>(null);
  const [pasting, setPasting] = useState(false);
  const [paste, setPaste] = useState("");
  useEffect(() => void api.truckLoadOrders(game).then(setOrders, () => setOrders([])), [game]);
  const profiles = scan?.profiles ?? [];
  const profile: TruckProfile | undefined = profiles.find((p) => p.dir === profileDir) ?? profiles[0];

  const byWorkshop = useMemo(() => new Map(mods.filter((m) => m.workshopId).map((m) => [m.workshopId!, m])), [mods]);
  const fileSet = useMemo(() => new Set((scan?.files ?? []).map((f) => stem(f.file).toLowerCase())), [scan]);
  const workshopSet = useMemo(() => new Set((scan?.workshop ?? []).map((w) => w.id)), [scan]);
  /** Every mod this PC could turn on: what the profile has, the mod folder's files and the Workshop items. */
  const available = useMemo<ActiveTruckMod[]>(() => {
    const out = new Map<string, ActiveTruckMod>();
    for (const m of profile?.mods ?? []) out.set(m.package.toLowerCase(), m);
    for (const f of scan?.files ?? []) {
      const pkg = stem(f.file);
      if (!out.has(pkg.toLowerCase())) out.set(pkg.toLowerCase(), { package: pkg, name: f.manifest?.name ?? truckModTitle(f.file) });
    }
    for (const w of scan?.workshop ?? []) {
      const pkg = workshopPackage(w.id);
      if (!out.has(pkg.toLowerCase())) out.set(pkg.toLowerCase(), { package: pkg, name: byWorkshop.get(w.id)?.name ?? `Workshop item ${w.id}` });
    }
    // The names on the mod list are other names for the same packages (a sheet's "Reforma Mod" is Reforma_2_9_7_158).
    const aliases: ActiveTruckMod[] = [];
    for (const t of mods) {
      const pkgs = t.workshopId ? [workshopPackage(t.workshopId)] : t.files.map(stem);
      for (const pkg of pkgs) {
        const have = out.get(pkg.toLowerCase());
        if (have && have.name !== t.name) aliases.push({ package: have.package, name: t.name });
      }
    }
    return [...out.values(), ...aliases];
  }, [profile, scan, mods, byWorkshop]);
  /** The package's own entry (its name in the game), not a list name it was matched by. */
  const canonical = (m: ActiveTruckMod) => available.find((a) => a.package === m.package) ?? m;
  const here = (pkg: string) => {
    const wid = workshopIdFromPackage(pkg);
    return wid ? workshopSet.has(wid) : fileSet.has(pkg.toLowerCase());
  };
  const tracked = (m: ActiveTruckMod) => {
    const wid = workshopIdFromPackage(m.package);
    if (wid) return byWorkshop.get(wid);
    return mods.find((t) => t.files.some((f) => stem(f).toLowerCase() === m.package.toLowerCase()));
  };

  const save = (name: string, list: ActiveTruckMod[], id: number | null = null) =>
    run("save", async () => {
      const o = await api.saveTruckLoadOrder(game, name, list);
      setOrders([o, ...(orders ?? []).filter((x) => x.id !== o.id && x.id !== id)]);
      setDraft({ id: o.id, name: o.name, mods: o.mods });
      setLine(`Saved “${o.name}” for every PC`);
    });
  const apply = (list: ActiveTruckMod[]) => {
    if (!profile) return;
    if (!window.confirm(`Put this load order in ${profile.name}? Close ${TRUCK_GAMES[game].short} first, or it writes its own list back when it exits. LootDen keeps a copy of the profile as it is now.`)) return;
    void run("apply", async () => {
      const r = await desktop!.applyTruckLoadOrder!(game, profile.dir, list);
      await rescan();
      setLine(`${profile.name} now has ${r.profile.mods.length} mods turned on. The old profile is kept as ${r.backup.split(/[\\/]/).pop()}.`);
    });
  };

  if (!desktop?.truckModScan) return <p className="muted small">Open LootDen's desktop app to read and set the load order in your game profiles.</p>;
  if (!scan) return <p className="muted small">Reading this PC…</p>;

  const matches = draft ? matchLoadOrder(draft.mods, available) : [];
  const move = (i: number, by: number) => {
    if (!draft) return;
    const list = [...draft.mods];
    const [x] = list.splice(i, 1);
    list.splice(Math.max(0, Math.min(list.length, i + by)), 0, x!);
    setDraft({ ...draft, mods: list });
  };

  return (
    <>
      <p className="muted small">The order is the game's Mod Manager from the top: a mod higher up wins over the ones below it. Saved load orders are kept on the server, so any PC can use them.</p>
      {!profiles.length && <p className="muted small">No profiles found in {scan.gameFolder}. Start the game once and make a profile.</p>}
      {profiles.length > 0 && (
        <label className="inline small truck-profile">
          Profile
          <select value={profile?.dir ?? ""} onChange={(e) => setProfileDir(e.target.value)}>
            {profiles.map((p) => (
              <option key={p.dir} value={p.dir}>
                {p.name}
                {p.cloud ? " (Steam Cloud)" : ""}
              </option>
            ))}
          </select>
        </label>
      )}
      {profile && profile.format !== "text" && (
        <div className="truck-note small">
          <p>
            This profile is saved in the game's coded format, which LootDen can't read. Turn on readable saves (it sets <code>g_save_format "2"</code> in the game's config.cfg), then start {TRUCK_GAMES[game].short}, load the profile and quit once.
          </p>
          {desktop.enableTruckTextSaves && (
            <button className="small" disabled={busy !== null} onClick={() => void run("text", async () => setLine((await desktop!.enableTruckTextSaves!(game)) ? "Readable saves are on. Start the game, load the profile and quit, then come back." : "Readable saves were already on. Start the game, load the profile and quit once."))}>
              Turn on readable saves
            </button>
          )}
        </div>
      )}
      {profile?.cloud && profile.format === "text" && <p className="muted small">This profile is in Steam Cloud. If Steam offers its cloud copy next time, keep the one on this PC.</p>}

      {profile && profile.format === "text" && (
        <>
          <h3 className="small">
            In {profile.name} now ({profile.mods.length})
          </h3>
          <ol className="truck-order">
            {profile.mods.map((m) => {
              const t = tracked(m);
              return (
                <li key={m.package}>
                  <span>{m.name}</span>
                  {workshopIdFromPackage(m.package) && <span className="badge badge-muted">Workshop</span>}
                  {!here(m.package) && <span className="badge truck-fit-outdated" title="The game skips a mod it can't find">Missing</span>}
                  {t?.retired && <span className="badge truck-fit-newer">Retired</span>}
                  {t?.check?.status === "dead" && <span className="badge truck-fit-outdated">Dead link</span>}
                </li>
              );
            })}
          </ol>
          <div className="inline wrap">
            <button className="small" disabled={busy !== null || !profile.mods.length} onClick={() => {
              const name = window.prompt("Name this load order", profile.name);
              if (name) void save(name, profile.mods);
            }}>
              Save for every PC…
            </button>
          </div>
        </>
      )}

      <h3 className="small">Saved load orders</h3>
      <div className="inline wrap">
        {(orders ?? []).map((o) => (
          <button key={o.id} className={`small${draft?.id === o.id ? "" : " ghost"}`} onClick={() => setDraft({ id: o.id, name: o.name, mods: o.mods })}>
            {o.name} ({o.mods.length})
          </button>
        ))}
        <button className="ghost small" onClick={() => setPasting(!pasting)}>
          Paste a list…
        </button>
      </div>
      {orders && !orders.length && !draft && <p className="muted small">None yet. Save the one in your profile, or paste a list (top of the Mod Manager first).</p>}
      {pasting && (
        <div className="truck-paste">
          <textarea rows={6} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="One mod per line, top of the Mod Manager first" />
          <button className="small" disabled={!paste.trim()} onClick={() => (setDraft({ id: null, name: "Pasted list", mods: parseLoadOrderText(paste) }), setPasting(false), setPaste(""))}>
            Use this list
          </button>
        </div>
      )}

      {draft && (
        <div className="truck-draft">
          <div className="inline wrap" style={{ justifyContent: "space-between" }}>
            <strong>{draft.name}</strong>
            <span className="muted small">
              {matches.filter((x) => x.match).length} of {matches.length} on this PC
            </span>
          </div>
          <ol className="truck-order">
            {matches.map((x, i) => (
              <li key={`${i}-${x.entry.package || x.entry.name}`} className={x.match ? "" : "truck-missing"}>
                <span>{x.entry.name}</span>
                {x.match ? x.match.name !== x.entry.name && <span className="muted small">→ {x.match.name}</span> : <span className="badge truck-fit-outdated">Not on this PC</span>}
                <span className="truck-order-tools">
                  <button className="ghost small" aria-label="Up" disabled={i === 0} onClick={() => move(i, -1)}>
                    ↑
                  </button>
                  <button className="ghost small" aria-label="Down" disabled={i === matches.length - 1} onClick={() => move(i, 1)}>
                    ↓
                  </button>
                  <button className="ghost small" aria-label="Take out" onClick={() => setDraft({ ...draft, mods: draft.mods.filter((_, j) => j !== i) })}>
                    ✕
                  </button>
                </span>
              </li>
            ))}
          </ol>
          <div className="inline wrap">
            <button
              className="ghost small"
              disabled={busy !== null}
              onClick={() => {
                const name = draft.id ? draft.name : window.prompt("Name this load order", draft.name);
                // Keep what each line was matched to, so other PCs match by package.
                if (name) void save(name, matches.map((x) => (x.match ? { package: x.match.package, name: x.entry.name } : x.entry)), draft.id);
              }}
            >
              Save changes
            </button>
            {profile?.format === "text" && desktop.applyTruckLoadOrder && (
              <button className="small" disabled={busy !== null || !matches.some((x) => x.match)} onClick={() => apply(matches.flatMap((x) => (x.match ? [canonical(x.match)] : [])))}>
                Put in {profile.name}
              </button>
            )}
            {draft.id && (
              <button
                className="ghost small"
                disabled={busy !== null}
                onClick={() =>
                  window.confirm(`Delete the saved load order “${draft.name}”?`) &&
                  void run("del", async () => {
                    await api.deleteTruckLoadOrder(draft.id!);
                    setOrders((orders ?? []).filter((o) => o.id !== draft.id));
                    setDraft(null);
                  })
                }
              >
                Delete
              </button>
            )}
          </div>
          {matches.some((x) => !x.match) && <p className="muted small">Mods not on this PC are left out when it's put in the profile.</p>}
        </div>
      )}
    </>
  );
}
