import assert from "node:assert/strict"
import { rmSync } from "node:fs"
import { after, before, test } from "node:test"
import { analyze, lexicographicOrder, validateScenario } from "../src/arbitration"
import { comparisonVector } from "../src/arbitration"
import { getAnalysis, importScenario, runAnalysis, Store } from "../src/db"
import { compareVersions } from "../src/db"

const baseNodes = [
  { name: "STD_DATA", format: "standard", id: "0x123", frameType: "data", dlc: 0, data: [] },
  { name: "STD_REMOTE", format: "standard", id: "0x123", frameType: "remote", dlc: 2, data: [] },
  { name: "EXT_DATA", format: "extended", id: "0x048C0000", frameType: "data", dlc: 0, data: [] },
] as const

test("0x123 三帧：标准数据帧在 RTR/SRR 位置胜出", () => {
  const scenario = validateScenario({ requestId: "r1", nodes: baseNodes })
  const result = analyze(scenario)
  assert.equal(result.outcome, "winner")
  assert.equal(result.winner, "STD_DATA")
  assert.deepEqual(result.steps.at(-1)!.eliminated, ["STD_REMOTE", "EXT_DATA"])
  assert.equal(result.steps.at(-1)!.bitIndex, 12)
  assert.equal(result.comparisonStoppedEarly, true)
})

test("移除标准数据帧：标准远程帧在 IDE 位置战胜扩展帧", () => {
  const scenario = validateScenario({ requestId: "r2", nodes: baseNodes.filter((node) => node.name !== "STD_DATA") })
  const result = analyze(scenario)
  assert.equal(result.winner, "STD_REMOTE")
  const ideStep = result.steps.find((step) => step.field === "IDE")
  assert.ok(ideStep)
  assert.deepEqual(ideStep.eliminated, ["EXT_DATA"])
  assert.equal(ideStep.bus, 0)
})

test("相同标识和载荷可共同发送；不同 DLC 或载荷为仲裁后冲突", () => {
  const same = analyze(validateScenario({
    requestId: "same",
    nodes: [
      { name: "A", format: "standard", id: "0x100", frameType: "data", dlc: 1, data: ["ab"] },
      { name: "B", format: "standard", id: "0x100", frameType: "data", dlc: 1, data: ["AB"] },
    ],
  }))
  assert.equal(same.outcome, "co_send")
  assert.deepEqual(same.survivors, ["A", "B"])

  const conflict = analyze(validateScenario({
    requestId: "conflict",
    nodes: [
      { name: "A", format: "standard", id: "0x100", frameType: "data", dlc: 1, data: ["11"] },
      { name: "B", format: "standard", id: "0x100", frameType: "data", dlc: 2, data: ["11", "22"] },
    ],
  }))
  assert.equal(conflict.outcome, "post_arbitration_conflict")
  assert.deepEqual(conflict.differences, ["DLC 不同", "数据载荷不同"])
})

test("标准 0、0x7FF 和扩展最大值范围合法，字典序与逐位淘汰一致", () => {
  const scenario = validateScenario({
    requestId: "limits",
    nodes: [
      { name: "MAX_STD", format: "standard", id: "0x7FF", frameType: "data", dlc: 0, data: [] },
      { name: "ZERO_STD", format: "standard", id: "0x000", frameType: "data", dlc: 0, data: [] },
      { name: "MAX_EXT", format: "extended", id: "0x1FFFFFFF", frameType: "data", dlc: 0, data: [] },
    ],
  })
  const order = lexicographicOrder(scenario.nodes).map((node) => node.name)
  assert.deepEqual(order, ["ZERO_STD", "MAX_STD", "MAX_EXT"])
  const result = analyze(scenario)
  assert.equal(result.winner, "ZERO_STD")
})

test("低十八位差异在扩展段第一处分歧淘汰", () => {
  const scenario = validateScenario({
    requestId: "low18",
    nodes: [
      { name: "LOW", format: "extended", id: "0x00000000", frameType: "data", dlc: 0, data: [] },
      { name: "HIGH", format: "extended", id: "0x00000001", frameType: "data", dlc: 0, data: [] },
    ],
  })
  const result = analyze(scenario)
  assert.equal(result.winner, "LOW")
  assert.equal(result.steps.at(-1)!.field, "IDENTIFIER")
  assert.equal(result.steps.at(-1)!.fieldPosition, 29)
})

test("单节点不比较即报告优胜并列出未比较位；节点顺序置换不改变结果", () => {
  const one = analyze(validateScenario({ requestId: "one", nodes: [baseNodes[0]] }))
  assert.equal(one.winner, "STD_DATA")
  assert.equal(one.steps.length, 0)
  assert.equal(one.uncomparedBits.length, comparisonVector(validateScenario({ requestId: "x", nodes: [baseNodes[0]] }).nodes[0]).length)

  const reversed = analyze(validateScenario({ requestId: "reversed", nodes: [...baseNodes].reverse() }))
  assert.equal(reversed.winner, "STD_DATA")
  assert.deepEqual(new Set(reversed.steps.at(-1)!.eliminated), new Set(["STD_REMOTE", "EXT_DATA"]))
})

test("非法 DLC、超范围标识、载荷长度不符、重复名称和缺失字段整体拒绝", () => {
  assert.throws(() => validateScenario({ requestId: "bad", nodes: [{ ...baseNodes[0], dlc: 9 }] }), /DLC/)
  assert.throws(() => validateScenario({ requestId: "bad", nodes: [{ ...baseNodes[0], id: "0x800" }] }), /超出/)
  assert.throws(() => validateScenario({ requestId: "bad", nodes: [{ ...baseNodes[0], id: "0x20000000", format: "extended" }] }), /超出/)
  assert.throws(() => validateScenario({ requestId: "bad", nodes: [{ ...baseNodes[0], dlc: 0, data: ["00"] }] }), /字节数/)
  assert.throws(() => validateScenario({ requestId: "bad", nodes: [baseNodes[0], baseNodes[0]] }), /重复/)
  assert.throws(() => validateScenario({ requestId: "bad", nodes: [{ name: "X", format: "standard", id: "0x000", frameType: "data" }] }), /缺少字段 dlc/)
})

const dbPath = "data/test-arbitration.sqlite"
let store: Store
before(() => {
  rmSync(dbPath, { force: true })
  store = new Store(dbPath)
})
after(() => {
  store.close()
  rmSync(dbPath, { force: true })
})

test("SQLite 持久化、请求幂等和重启后可读取真实逐位记录", () => {
  const imported = importScenario(store, { requestId: "persist-1", nodes: baseNodes })
  const first = runAnalysis(store, "persist-1")
  assert.equal(first.reused, false)
  assert.equal(runAnalysis(store, "persist-1").reused, true)
  store.close()
  store = new Store(dbPath)
  const reopened = getAnalysis(store, "persist-1")
  assert.equal(reopened.version, imported.version)
  assert.equal(reopened.result.steps.length, first.result.steps.length)
  assert.equal(reopened.result.rulesVersion, first.result.rulesVersion)
})

test("相同 scenarioKey 修改标识创建新版本，旧报告保持不变", () => {
  importScenario(store, {
    requestId: "version-a",
    scenarioKey: "family-a",
    name: "版本族",
    nodes: [{ name: "A", format: "standard", id: "0x100", frameType: "data", dlc: 0, data: [] }],
  })
  runAnalysis(store, "version-a")
  importScenario(store, {
    requestId: "version-b",
    scenarioKey: "family-a",
    name: "版本族",
    nodes: [{ name: "A", format: "standard", id: "0x200", frameType: "data", dlc: 0, data: [] }],
  })
  runAnalysis(store, "version-b")
  const versions = compareVersions(store, "version-a")
  assert.equal(versions.length, 2)
  assert.equal(versions[0].version, 1)
  assert.equal(versions[1].version, 2)
  assert.equal(versions[0].analysis.winner, "A")
  assert.equal(versions[1].analysis.winner, "A")
  assert.equal(versions[0].analysis.steps.length, 0)
  assert.equal(versions[1].analysis.steps.length, 0)
  assert.notEqual(versions[0].createdAt, versions[1].createdAt)
})
