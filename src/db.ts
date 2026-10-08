import { DatabaseSync } from "node:sqlite"
import { createHash } from "node:crypto"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { AnalysisResult, NormalizedScenario } from "./types"
import { analyze, ConflictError, NotFoundError, RULES_VERSION, validateScenario } from "./arbitration"

interface ScenarioRecord {
  id: number
  request_id: string
  scenario_key: string
  name: string
  version: number
  input_json: string
  normalized_json: string
  created_at: string
}

interface AnalysisRecord {
  id: number
  scenario_id: number
  request_id: string
  rules_version: string
  result_json: string
  created_at: string
}

export class Store {
  readonly db: DatabaseSync

  constructor(dbPath = "data/can-arbitration.sqlite") {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec("PRAGMA foreign_keys = ON")
    this.migrate()
  }

  close() {
    this.db.close()
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scenarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL,
        scenario_key TEXT NOT NULL,
        name TEXT NOT NULL,
        version INTEGER NOT NULL,
        input_json TEXT NOT NULL,
        normalized_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE(request_id),
        UNIQUE(scenario_key, version)
      );
      CREATE TABLE IF NOT EXISTS analyses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scenario_id INTEGER NOT NULL UNIQUE,
        request_id TEXT NOT NULL,
        rules_version TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        FOREIGN KEY(scenario_id) REFERENCES scenarios(id)
      );
      CREATE TABLE IF NOT EXISTS analysis_steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        analysis_id INTEGER NOT NULL,
        step INTEGER NOT NULL,
        bit_index INTEGER NOT NULL,
        field TEXT NOT NULL,
        field_position INTEGER NOT NULL,
        source_bit INTEGER,
        participants_json TEXT NOT NULL,
        sent_json TEXT NOT NULL,
        bus INTEGER NOT NULL,
        eliminated_json TEXT NOT NULL,
        survivors_json TEXT NOT NULL,
        node_bits_json TEXT,
        FOREIGN KEY(analysis_id) REFERENCES analyses(id)
      );
    `)
    const columns = this.db.prepare("PRAGMA table_info(analysis_steps)").all() as unknown as Array<{ name: string }>
    if (!columns.some((column) => column.name === "node_bits_json")) {
      this.db.exec("ALTER TABLE analysis_steps ADD COLUMN node_bits_json TEXT")
    }
  }
}

function canonicalInput(input: unknown): string {
  return JSON.stringify(input, Object.keys(input as object).sort())
}

function scenarioKey(normalized: NormalizedScenario): string {
  if (normalized.scenarioKey) return normalized.scenarioKey
  const material = JSON.stringify({
    name: normalized.name,
    nodes: normalized.nodes
      .map((node) => ({ name: node.name, format: node.format, id: node.id, frameType: node.frameType, dlc: node.dlc, data: node.data }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  })
  return createHash("sha256").update(material).digest("hex").slice(0, 24)
}

export function importScenario(store: Store, rawInput: unknown): { scenario: NormalizedScenario; id: number; version: number; reused: boolean } {
  const normalized = validateScenario(rawInput)
  const existing = store.db.prepare("SELECT * FROM scenarios WHERE request_id = ?").get(normalized.requestId) as ScenarioRecord | undefined
  if (existing) {
    const oldInput = reviveScenario(JSON.parse(existing.normalized_json) as NormalizedScenario)
    if (JSON.stringify(stripBigInt(oldInput)) !== JSON.stringify(stripBigInt(normalized))) {
      throw new ConflictError("相同 requestId 对应不同场景内容", { requestId: normalized.requestId })
    }
    return { scenario: oldInput, id: existing.id, version: existing.version, reused: true }
  }

  const key = scenarioKey(normalized)
  store.db.exec("BEGIN IMMEDIATE")
  try {
    const latest = store.db.prepare("SELECT MAX(version) AS version FROM scenarios WHERE scenario_key = ?").get(key) as { version: number | null }
    const version = (latest.version ?? 0) + 1
    const info = store.db.prepare(`
      INSERT INTO scenarios(request_id, scenario_key, name, version, input_json, normalized_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(normalized.requestId, key, normalized.name, version, canonicalInput(rawInput), JSON.stringify(stripBigInt(normalized)))
    const inserted = { scenario: normalized, id: Number(info.lastInsertRowid), version, reused: false }
    store.db.exec("COMMIT")
    return inserted
  } catch (error) {
    store.db.exec("ROLLBACK")
    throw error
  }
}

export function getScenario(store: Store, idOrRequest: string | number): NormalizedScenario & { id: number; version: number } {
  const row = typeof idOrRequest === "number"
    ? store.db.prepare("SELECT * FROM scenarios WHERE id = ?").get(idOrRequest) as ScenarioRecord | undefined
    : /^\d+$/.test(idOrRequest)
      ? store.db.prepare("SELECT * FROM scenarios WHERE id = ? OR request_id = ?").get(Number(idOrRequest), idOrRequest) as ScenarioRecord | undefined
      : store.db.prepare("SELECT * FROM scenarios WHERE request_id = ?").get(idOrRequest) as ScenarioRecord | undefined
  if (!row) throw new NotFoundError("场景不存在")
  return { ...reviveScenario(JSON.parse(row.normalized_json) as NormalizedScenario), id: row.id, version: row.version }
}

export function listScenarios(store: Store) {
  return (store.db.prepare("SELECT id, request_id, scenario_key, name, version, created_at FROM scenarios ORDER BY id DESC").all() as Array<Record<string, unknown>>).map((row) => row)
}

export function runAnalysis(store: Store, requestId: string): { scenarioId: number; version: number; result: AnalysisResult; reused: boolean } {
  const scenarioRow = store.db.prepare("SELECT * FROM scenarios WHERE request_id = ?").get(requestId) as ScenarioRecord | undefined
  if (!scenarioRow) throw new NotFoundError("场景不存在，请先导入")
  const existing = store.db.prepare("SELECT * FROM analyses WHERE scenario_id = ?").get(scenarioRow.id) as AnalysisRecord | undefined
  if (existing) {
    return { scenarioId: scenarioRow.id, version: scenarioRow.version, result: JSON.parse(existing.result_json) as AnalysisResult, reused: true }
  }
  const scenario = reviveScenario(JSON.parse(scenarioRow.normalized_json) as NormalizedScenario)
  const result = analyze(scenario)

  store.db.exec("BEGIN IMMEDIATE")
  try {
    const info = store.db.prepare("INSERT INTO analyses(scenario_id, request_id, rules_version, result_json) VALUES (?, ?, ?, ?)")
      .run(scenarioRow.id, requestId, RULES_VERSION, JSON.stringify(result))
    const analysisId = Number(info.lastInsertRowid)
    const stmt = store.db.prepare(`
      INSERT INTO analysis_steps(analysis_id, step, bit_index, field, field_position, source_bit, participants_json, sent_json, bus, eliminated_json, survivors_json, node_bits_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const step of result.steps) {
      stmt.run(analysisId, step.step, step.bitIndex, step.field, step.fieldPosition, step.sourceBit, JSON.stringify(step.participantsBefore), JSON.stringify(step.sent), step.bus, JSON.stringify(step.eliminated), JSON.stringify(step.survivors), JSON.stringify(step.bitByNode))
    }
    store.db.exec("COMMIT")
  } catch (error) {
    store.db.exec("ROLLBACK")
    throw error
  }
  return { scenarioId: scenarioRow.id, version: scenarioRow.version, result, reused: false }
}

export function getAnalysis(store: Store, requestId: string) {
  const scenario = getScenario(store, requestId)
  const row = store.db.prepare("SELECT * FROM analyses WHERE scenario_id = ?").get(scenario.id) as AnalysisRecord | undefined
  if (!row) throw new NotFoundError("该场景尚未运行分析")
  const result = JSON.parse(row.result_json) as AnalysisResult
  const persistedSteps = store.db.prepare("SELECT * FROM analysis_steps WHERE analysis_id = ? ORDER BY step").all(row.id) as unknown as Array<Record<string, unknown>>
  if (persistedSteps.length > 0) {
    result.steps = persistedSteps.map((step) => ({
      step: Number(step.step),
      bitIndex: Number(step.bit_index),
      field: String(step.field),
      fieldPosition: Number(step.field_position),
      sourceBit: step.source_bit === null ? null : Number(step.source_bit),
      bitByNode: JSON.parse(String(step.node_bits_json ?? "{}")),
      participantsBefore: JSON.parse(String(step.participants_json)),
      sent: JSON.parse(String(step.sent_json)),
      bus: Number(step.bus) as 0 | 1,
      eliminated: JSON.parse(String(step.eliminated_json)),
      survivors: JSON.parse(String(step.survivors_json)),
    }))
  }
  return { scenarioId: scenario.id, version: scenario.version, result }
}

export function getNodeReason(store: Store, requestId: string, nodeName: string) {
  const analysis = getAnalysis(store, requestId)
  const reason = analysis.result.eliminated.find((item) => item.node === nodeName)
  if (!reason) {
    if (!analysis.result.survivors.includes(nodeName)) throw new NotFoundError("节点不存在")
    return { node: nodeName, eliminated: false, reason: "节点通过仲裁，未因发送隐性位而退出" }
  }
  return { ...reason, eliminated: true }
}

export function compareVersions(store: Store, requestId: string) {
  const current = getScenario(store, requestId)
  const rows = store.db.prepare("SELECT * FROM scenarios WHERE scenario_key = (SELECT scenario_key FROM scenarios WHERE id = ?) ORDER BY version").all(current.id) as unknown as ScenarioRecord[]
  return rows.map((row) => {
    const analysis = store.db.prepare("SELECT result_json FROM analyses WHERE scenario_id = ?").get(row.id) as { result_json: string } | undefined
    return {
      id: row.id,
      requestId: row.request_id,
      version: row.version,
      createdAt: row.created_at,
      analysis: analysis ? JSON.parse(analysis.result_json) : null,
    }
  })
}

function stripBigInt(value: unknown): unknown {
  if (typeof value === "bigint") return `0x${value.toString(16).toUpperCase()}`
  if (Array.isArray(value)) return value.map(stripBigInt)
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, stripBigInt(item)]))
  return value
}

function reviveScenario(scenario: NormalizedScenario): NormalizedScenario {
  return {
    ...scenario,
    nodes: scenario.nodes.map((node) => {
      const idValue = typeof node.idValue === "bigint"
        ? node.idValue
        : BigInt(String(node.idValue).startsWith("0x") ? String(node.idValue) : `0x${String(node.idValue)}`)
      return { ...node, idValue, data: node.data ?? [] }
    }),
  }
}
