import { arbitrate } from "./arbitrate.js";
import { Store } from "./db.js";
import { ApiError } from "./errors.js";
import { buildVector } from "./vector.js";
import { toCanNodes, validateScenario } from "./validate.js";
import { MAX_EXPORT_ROWS, RunResult, Scenario, StepRecord } from "./types.js";

export function importScenario(store: Store, raw: unknown, idemKey?: string) {
  const scenario = validateScenario(raw);
  return store.withIdempotency(idemKey, () => {
    const row = store.importScenario(scenario);
    return {
      name: row.name,
      version: row.version,
      rulesVersion: row.rules_version,
      nodeCount: scenario.nodes.length,
      createdAt: row.created_at,
    };
  });
}

export function getVectors(store: Store, name: string, version?: number) {
  const row = store.getScenario(name, version);
  const scenario = JSON.parse(row.payload) as Scenario;
  const nodes = toCanNodes(scenario);
  return {
    name: row.name,
    version: row.version,
    rulesVersion: row.rules_version,
    vectors: nodes.map((n) => ({
      node: n.name,
      format: n.format,
      id: "0x" + n.id.toString(16).toUpperCase(),
      sof: 0,
      bits: buildVector(n),
    })),
  };
}

export function runArbitration(store: Store, name: string, version?: number, idemKey?: string) {
  const row = store.getScenario(name, version);
  return store.withIdempotency(idemKey, () => {
    const scenario = JSON.parse(row.payload) as Scenario;
    const result = arbitrate(toCanNodes(scenario));
    const run = store.saveRun(row, result);
    return {
      runId: run.id,
      name: row.name,
      version: row.version,
      rulesVersion: run.rules_version,
      status: result.status,
      winners: result.winners,
      coTransmit: result.coTransmit,
      conflictFields: result.conflictFields,
      note: result.note,
      totalComparedBits: result.totalComparedBits,
      steps: result.steps,
    };
  });
}

export function getRun(store: Store, runId: number) {
  const run = store.getRun(runId);
  const result = JSON.parse(run.result) as Omit<RunResult, "steps">;
  const steps = JSON.parse(run.steps) as StepRecord[];
  return { runId: run.id, scenarioId: run.scenario_id, scenarioVersion: run.scenario_version, rulesVersion: run.rules_version, ...result, steps };
}

export function eliminationReason(store: Store, runId: number, nodeName: string) {
  const run = getRun(store, runId);
  for (const step of run.steps) {
    if (step.dropped.includes(nodeName)) {
      const info = step.sent[nodeName];
      return {
        runId,
        node: nodeName,
        eliminated: true,
        atBit: step.index,
        field: info.field,
        fieldPos: info.fieldPos,
        idBit: info.idBit,
        sentBit: info.bit,
        busBit: step.bus,
        reason: `节点 "${nodeName}" 在比较位 ${step.index}（${info.field}${info.idBit !== undefined ? ` 标识位 ${info.idBit}` : ` 字段内位置 ${info.fieldPos}`}）发送隐性 1，但总线为显性 0，失去仲裁`,
        survivorsAfter: step.survivors,
      };
    }
  }
  if (run.winners.includes(nodeName)) {
    return { runId, node: nodeName, eliminated: false, status: run.status, reason: `节点 "${nodeName}" 未被淘汰（${run.status}）` };
  }
  throw new ApiError("E_NOT_FOUND", `节点 "${nodeName}" 不在运行 #${runId} 中`);
}

export function diffVersions(store: Store, name: string, a: number, b: number) {
  const va = store.getScenario(name, a);
  const vb = store.getScenario(name, b);
  const na = (JSON.parse(va.payload) as Scenario).nodes;
  const nb = (JSON.parse(vb.payload) as Scenario).nodes;
  const mapA = new Map(na.map((n) => [n.name, n]));
  const mapB = new Map(nb.map((n) => [n.name, n]));
  const added = [...mapB.keys()].filter((k) => !mapA.has(k));
  const removed = [...mapA.keys()].filter((k) => !mapB.has(k));
  const changed = [...mapA.keys()]
    .filter((k) => mapB.has(k) && JSON.stringify(mapA.get(k)) !== JSON.stringify(mapB.get(k)))
    .map((k) => ({ node: k, before: mapA.get(k), after: mapB.get(k) }));
  return { name, versionA: a, versionB: b, rulesVersionA: va.rules_version, rulesVersionB: vb.rules_version, added, removed, changed };
}

export function exportRun(store: Store, runId: number, format: "json" | "csv"): string {
  const run = getRun(store, runId);
  if (run.steps.length > MAX_EXPORT_ROWS) {
    throw new ApiError("E_EXPORT_LIMIT", `步数 ${run.steps.length} 超过导出上限 ${MAX_EXPORT_ROWS}`);
  }
  if (format === "json") return JSON.stringify(run, null, 2);
  const header = "bit_index,node,sent_bit,field,field_pos,id_bit,bus,dropped,survivors";
  const lines = [header];
  for (const s of run.steps) {
    for (const p of s.participants) {
      const info = s.sent[p];
      lines.push(
        [s.index, p, info.bit, info.field, info.fieldPos, info.idBit ?? "", s.bus, s.dropped.includes(p) ? 1 : 0, s.survivors.join("|")].join(",")
      );
    }
  }
  return lines.join("\n");
}
