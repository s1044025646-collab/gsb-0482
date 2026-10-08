#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { compareVersions, getAnalysis, getNodeReason, getScenario, importScenario, listScenarios, runAnalysis, Store } from "./db"
import { analyze, comparisonVector, lexicographicOrder, validateScenario } from "./arbitration"

const [command, ...rest] = process.argv.slice(2)
const option = (name: string) => {
  const inline = rest.find((arg) => arg.startsWith(`--${name}=`))
  if (inline) return inline.slice(`--${name}=`.length)
  const index = rest.indexOf(`--${name}`)
  return index >= 0 ? rest[index + 1] : undefined
}
const store = new Store(`${option("data-dir") ?? "data"}/can-arbitration.sqlite`)

function fail(error: unknown): never {
  if (error instanceof Error) console.error(`错误[${(error as { code?: string }).code ?? "ERROR"}]: ${error.message}`)
  else console.error(error)
  process.exit(1)
}

function table(headers: string[], rows: string[][]) {
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => Array.from(row[index] ?? "").length)))
  const line = (cells: string[]) => cells.map((cell, index) => cell.padEnd(widths[index], " ")).join("  ")
  console.log(line(headers))
  console.log(widths.map((width) => "-".repeat(width)).join("  "))
  for (const row of rows) console.log(line(row))
}

try {
  if (command === "import") {
    const file = rest.find((arg) => !arg.startsWith("--"))
    if (!file) throw new Error("用法: can-arb import <scenario.json>")
    const imported = importScenario(store, JSON.parse(readFileSync(resolve(file), "utf8")))
    console.log(JSON.stringify({ scenarioId: imported.id, requestId: imported.scenario.requestId, version: imported.version, reused: imported.reused }, null, 2))
  } else if (command === "list") {
    table(["ID", "版本", "请求号", "名称"], listScenarios(store).map((row) => [String(row.id), String(row.version), String(row.request_id), String(row.name)]))
  } else if (command === "vectors") {
    const id = rest.find((arg) => !arg.startsWith("--"))!
    const scenario = getScenario(store, id)
    for (const node of scenario.nodes) {
      const vector = comparisonVector(node)
      console.log(`${node.name}: ${vector.map((bit) => bit.value).join("")}`)
      console.log(`       ${vector.map((bit) => (bit.field === "IDENTIFIER" ? "0" : bit.field[0])).join("")}`)
      console.log(`       ${vector.map((bit) => String(bit.bitIndex).padStart(2, "0").slice(-1)).join("")}`)
    }
    console.log("字典序优先级:", lexicographicOrder(scenario.nodes).map((node) => node.name).join(" > "))
  } else if (command === "analyze") {
    const id = rest.find((arg) => !arg.startsWith("--"))!
    const analysis = runAnalysis(store, id)
    const names = analysis.result.steps[0]?.participantsBefore ?? analysis.result.survivors
    table(
      ["步", "位", "字段", "总线", ...names, "退出"],
      analysis.result.steps.map((step) => [
        String(step.step).padStart(2, "0"),
        String(step.bitIndex).padStart(2, "0"),
        `${step.field}${step.fieldPosition}`,
        String(step.bus),
        ...names.map((name) => String(step.sent[name] ?? "-")),
        step.eliminated.join(","),
      ])
    )
    console.log(`结果: ${analysis.result.outcome}`)
    if (analysis.result.winner) console.log(`优胜节点: ${analysis.result.winner}`)
    console.log(`存活节点: ${analysis.result.survivors.join(", ")}`)
    if (analysis.result.comparisonStoppedEarly) console.log(`仅剩一个节点，后续 ${analysis.result.uncomparedBits.length} 个比较位未继续仲裁`)
    if (analysis.result.differences) console.log(`仲裁后差异: ${analysis.result.differences.join("；")}`)
  } else if (command === "reason") {
    const [id, nodeName] = rest.filter((arg) => !arg.startsWith("--"))
    console.log(JSON.stringify(getNodeReason(store, id, nodeName), null, 2))
  } else if (command === "versions") {
    const id = rest.find((arg) => !arg.startsWith("--"))!
    const versions = compareVersions(store, id)
    console.log(JSON.stringify(versions, null, 2))
  } else if (command === "export") {
    const id = rest.find((arg) => !arg.startsWith("--"))!
    const format = option("format") ?? "json"
    const out = option("out")
    const analysis = getAnalysis(store, id)
    const payload = format === "csv"
      ? [
          "step,bitIndex,field,node,sent,bus,eliminated",
          ...analysis.result.steps.flatMap((step) => Object.entries(step.sent).map(([node, sent]) => [step.step, step.bitIndex, step.field + step.fieldPosition, node, sent, step.bus, step.eliminated.includes(node)].join(","))),
        ].join("\n")
      : JSON.stringify(analysis, null, 2)
    if (out) writeFileSync(resolve(out), payload)
    else console.log(payload)
  } else if (command === "demo") {
    const demo = { requestId: `demo-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`, nodes: demoNodes() }
    const imported = importScenario(store, demo)
    const result = analyze(imported.scenario)
    runAnalysis(store, demo.requestId)
    console.log(`请求号: ${demo.requestId}`)
    console.log(`预期字典序: ${lexicographicOrder(imported.scenario.nodes).map((node) => node.name).join(" > ")}`)
    console.log(`结果: ${result.outcome}, 优胜: ${result.winner}`)
    console.log("已保存到 SQLite；可用 npm run cli -- analyze " + demo.requestId + " 查看零一列")
  } else {
    console.log("命令: import | list | vectors | analyze | reason | versions | export | demo")
  }
} catch (error) {
  fail(error)
} finally {
  store.close()
}

function demoNodes() {
  return [
    { name: "STD_DATA", format: "standard", id: "0x123", frameType: "data", dlc: 0, data: [] },
    { name: "STD_REMOTE", format: "standard", id: "0x123", frameType: "remote", dlc: 2, data: [] },
    { name: "EXT_DATA", format: "extended", id: "0x048C0000", frameType: "data", dlc: 0, data: [] },
  ]
}
