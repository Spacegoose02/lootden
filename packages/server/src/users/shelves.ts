import { cleanSmartRules, smartShelfGames, type GameSummary, type RuleContext, type SmartRules } from "@lootden/shared";
import type { Library } from "../catalog/library.js";
import { json, now, type Db } from "../db/database.js";

/** A shelf of games: someone's own, or a household shelf an admin made for everyone. */
export interface Shelf {
  id: number;
  name: string;
  emoji: string | null;
  description: string | null;
  /** Shown to everyone (made by an admin), instead of only its owner. */
  household: boolean;
  /** Shown as a row on Home. */
  onHome: boolean;
  ownerId: number | null;
  /** The person looking can change it. */
  mine: boolean;
  /** A smart shelf fills itself with the games that match these; null for one filled by hand. */
  rules: SmartRules | null;
  games: GameSummary[];
}

interface ShelfRow {
  id: number;
  user_id: number | null;
  name: string;
  emoji: string | null;
  description: string | null;
  household: number;
  on_home: number;
  position: number;
  rules: string | null;
}

export interface ShelfInput {
  name?: string;
  emoji?: string | null;
  description?: string | null;
  household?: boolean;
  onHome?: boolean;
  /** Smart shelf rules; null makes it an ordinary shelf again. */
  rules?: unknown;
}

/** One emoji (or a short symbol), so a shelf's icon can't carry markup or a paragraph. */
const cleanEmoji = (x: unknown) => {
  const s = typeof x === "string" ? x.trim() : "";
  return s && [...s].length <= 8 && !/[<>&"'\w]/.test(s) ? s : null;
};

/** Hand-made shelves ("Halloween picks", "Dad's retro corner") shown in the Library and on Home. */
export class ShelfStore {
  /** What smart shelves know about the person looking (statuses, tags, play); set once the stores exist. */
  ruleContext: (userId: number) => RuleContext = () => ({ status: () => null, marks: () => ({ favourite: false, hidden: false, tags: [], fields: {} }), played: () => false, installed: () => false });

  constructor(
    private readonly db: Db,
    private readonly library: Library,
  ) {}

  /** The household's shelves and this person's own; kid profiles only see kid-safe games on them. */
  list(userId: number, kidMode: boolean): Shelf[] {
    const rows = this.db.prepare("SELECT * FROM shelves WHERE household = 1 OR user_id = ? ORDER BY household DESC, position, id").all(userId) as unknown as ShelfRow[];
    const games = new Map(this.library.list({ kidSafe: kidMode, kind: "all" }).map((g) => [g.id, g]));
    return rows.map((r) => this.view(r, userId, games));
  }

  get(id: number, userId: number, kidMode: boolean): Shelf {
    const r = this.row(id);
    if (!r.household && r.user_id !== userId) throw new Error("No such shelf");
    return this.view(r, userId, new Map(this.library.list({ kidSafe: kidMode, kind: "all" }).map((g) => [g.id, g])));
  }

  private view(r: ShelfRow, userId: number, games: Map<string, GameSummary>): Shelf {
    const rules = r.rules ? json<SmartRules | null>(r.rules, null) : null;
    if (rules) {
      return {
        id: r.id,
        name: r.name,
        emoji: r.emoji,
        description: r.description,
        household: r.household === 1,
        onHome: r.on_home === 1,
        ownerId: r.user_id,
        mine: r.user_id === userId,
        rules,
        games: smartShelfGames([...games.values()], rules, this.ruleContext(userId)),
      };
    }
    const ids = (this.db.prepare("SELECT game_id FROM shelf_games WHERE shelf_id = ? ORDER BY position, added_at").all(r.id) as Array<{ game_id: string }>).map((x) => x.game_id);
    return {
      rules: null,
      id: r.id,
      name: r.name,
      emoji: r.emoji,
      description: r.description,
      household: r.household === 1,
      onHome: r.on_home === 1,
      ownerId: r.user_id,
      mine: r.user_id === userId,
      games: ids.map((id) => games.get(id)).filter((g): g is GameSummary => !!g),
    };
  }

  private row(id: number): ShelfRow {
    const r = this.db.prepare("SELECT * FROM shelves WHERE id = ?").get(id) as ShelfRow | undefined;
    if (!r) throw new Error("No such shelf");
    return r;
  }

  /** Only its owner changes a personal shelf; household shelves are any admin's. */
  private editable(id: number, userId: number, admin: boolean): ShelfRow {
    const r = this.row(id);
    if (r.household ? !admin : r.user_id !== userId) throw new Error(r.household ? "Only admins change household shelves" : "No such shelf");
    return r;
  }

  create(userId: number, admin: boolean, input: ShelfInput): number {
    const name = String(input.name ?? "").trim().slice(0, 60);
    if (!name) throw new Error("Give the shelf a name");
    const household = input.household === true;
    if (household && !admin) throw new Error("Only admins make household shelves");
    const position = (this.db.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS p FROM shelves").get() as { p: number }).p;
    const rules = cleanSmartRules(input.rules);
    const r = this.db
      .prepare("INSERT INTO shelves (user_id, name, emoji, description, household, on_home, position, created_at, rules) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id")
      .get(userId, name, cleanEmoji(input.emoji), String(input.description ?? "").trim().slice(0, 200) || null, household ? 1 : 0, input.onHome === false ? 0 : 1, position, now(), rules ? JSON.stringify(rules) : null) as { id: number };
    return r.id;
  }

  update(id: number, userId: number, admin: boolean, input: ShelfInput): void {
    const r = this.editable(id, userId, admin);
    if (input.household !== undefined && input.household !== (r.household === 1) && !admin) throw new Error("Only admins make household shelves");
    const name = input.name === undefined ? r.name : String(input.name).trim().slice(0, 60);
    if (!name) throw new Error("Give the shelf a name");
    this.db
      .prepare("UPDATE shelves SET name = ?, emoji = ?, description = ?, household = ?, on_home = ?, rules = ? WHERE id = ?")
      .run(
        name,
        input.emoji === undefined ? r.emoji : cleanEmoji(input.emoji),
        input.description === undefined ? r.description : String(input.description ?? "").trim().slice(0, 200) || null,
        input.household === undefined ? r.household : input.household ? 1 : 0,
        input.onHome === undefined ? r.on_home : input.onHome ? 1 : 0,
        input.rules === undefined ? r.rules : (() => {
          const rules = cleanSmartRules(input.rules);
          return rules ? JSON.stringify(rules) : null;
        })(),
        id,
      );
  }

  remove(id: number, userId: number, admin: boolean): void {
    this.editable(id, userId, admin);
    this.db.prepare("DELETE FROM shelves WHERE id = ?").run(id);
  }

  addGame(id: number, userId: number, admin: boolean, gameId: string): void {
    if (this.editable(id, userId, admin).rules) throw new Error("This smart shelf fills itself; change its rules instead");
    if (!this.library.get(gameId, false)) throw new Error("No such game");
    const position = (this.db.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS p FROM shelf_games WHERE shelf_id = ?").get(id) as { p: number }).p;
    this.db.prepare("INSERT OR IGNORE INTO shelf_games (shelf_id, game_id, position, added_at) VALUES (?, ?, ?, ?)").run(id, gameId, position, now());
  }

  removeGame(id: number, userId: number, admin: boolean, gameId: string): void {
    this.editable(id, userId, admin);
    this.db.prepare("DELETE FROM shelf_games WHERE shelf_id = ? AND game_id = ?").run(id, gameId);
  }

  /** The shelves (of those this person sees) a game is on. */
  forGame(gameId: string, userId: number): number[] {
    return (
      this.db
        .prepare("SELECT s.id FROM shelf_games g JOIN shelves s ON s.id = g.shelf_id WHERE g.game_id = ? AND (s.household = 1 OR s.user_id = ?)")
        .all(gameId, userId) as Array<{ id: number }>
    ).map((r) => r.id);
  }
}
