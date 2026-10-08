import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { ApiError } from "./errors.js";
import { RULES_VERSION, RunResult, Scenario } from "./types.js";

export interface ScenarioRow {
  id: number;
  name: string;
  version: number;
  payload: string;
  hash: string;
  rules_version: string;
  created_at: string;
}

export interface RunRow {
  id: number;
  scenario_id: number;
  scenario_version: number;
  rules_version: string;
  result: string;
  steps: string;
  created_at: string;
}

export function scenarioHash(s: Scenario): string {
  return createHash("sha256").update(JSON.stringify({ nodes: s.nodes })).digest("hex");
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS scenarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        version INTEGER NOT NULL,
        payload TEXT NOT NULL,
        hash TEXT NOT NULL,
        rules_version TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE(name, version)
      );
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scenario_id INTEGER NOT NULL REFERENCES scenarios(id),
        scenario_version INTEGER NOT NULL,
        rules_version TEXT NOT NULL,
        result TEXT NOT NULL,
        steps TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE IF NOT EXISTS idempotency (
        key TEXT PRIMARY KEY,
        response TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  /** 幂等：同一 key 直接返回首个响应；分析失败时不写入，不发布半份结果。 */
  withIdempotency<T>(key: string | undefined, fn: () => T): { body: T; replayed: boolean } {
    if (key) {
      const row = this.db.prepare("SELECT response FROM idempotency WHERE key = ?").get(key) as
        | { response: string }
        | undefined;
      if (row) return { body: JSON.parse(row.response) as T, replayed: true };
    }
    const body = fn();
    if (key) {
      this.db.prepare("INSERT OR IGNORE INTO idempotency(key, response) VALUES (?, ?)").run(
        key,
        JSON.stringify(body)
      );
    }
    return { body, replayed: false };
  }

  /** 导入场景：同名同内容返回已有版本；内容变化创建新版本，旧版本与旧报告不变。 */
  importScenario(scenario: Scenario): ScenarioRow {
    const hash = scenarioHash(scenario);
    const latest = this.db
      .prepare("SELECT * FROM scenarios WHERE name = ? ORDER BY version DESC LIMIT 1")
      .get(scenario.name) as ScenarioRow | undefined;
    if (latest && latest.hash === hash && latest.rules_version === RULES_VERSION) return latest;
    const version = latest ? latest.version + 1 : 1;
    const info = this.db
      .prepare("INSERT INTO scenarios(name, version, payload, hash, rules_version) VALUES (?, ?, ?, ?, ?)")
      .run(scenario.name, version, JSON.stringify(scenario), hash, RULES_VERSION);
    return this.db.prepare("SELECT * FROM scenarios WHERE id = ?").get(Number(info.lastInsertRowid)) as unknown as ScenarioRow;
  }

  getScenario(name: string, version?: number): ScenarioRow {
    const row = (
      version !== undefined
        ? this.db.prepare("SELECT * FROM scenarios WHERE name = ? AND version = ?").get(name, version)
        : this.db.prepare("SELECT * FROM scenarios WHERE name = ? ORDER BY version DESC LIMIT 1").get(name)
    ) as ScenarioRow | undefined;
    if (!row) {
      throw new ApiError("E_NOT_FOUND", `场景 "${name}"${version !== undefined ? ` 版本 ${version}` : ""} 不存在`);
    }
    return row;
  }

  listVersions(name: string): ScenarioRow[] {
    return this.db.prepare("SELECT * FROM scenarios WHERE name = ? ORDER BY version").all(name) as unknown as ScenarioRow[];
  }

  /** 保存一次仲裁运行（结果 + 每步记录），整体在一个事务里，失败不落半份。 */
  saveRun(scenario: ScenarioRow, result: RunResult): RunRow {
    this.db.exec("BEGIN");
    try {
      const info = this.db
        .prepare("INSERT INTO runs(scenario_id, scenario_version, rules_version, result, steps) VALUES (?, ?, ?, ?, ?)")
        .run(
          scenario.id,
          scenario.version,
          RULES_VERSION,
          JSON.stringify({ ...result, steps: undefined }),
          JSON.stringify(result.steps)
        );
      this.db.exec("COMMIT");
      return this.db.prepare("SELECT * FROM runs WHERE id = ?").get(Number(info.lastInsertRowid)) as unknown as RunRow;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  getRun(id: number): RunRow {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
    if (!row) throw new ApiError("E_NOT_FOUND", `运行记录 #${id} 不存在`);
    return row;
  }

  listRuns(limit: number): RunRow[] {
    return this.db
      .prepare("SELECT * FROM runs ORDER BY id DESC LIMIT ?")
      .all(limit) as unknown as RunRow[];
  }
}

export function defaultDbPath(): string {
  return join(process.cwd(), "data", "can-arb.db");
}
