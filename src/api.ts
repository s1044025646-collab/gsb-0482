import { createServer, IncomingMessage, Server, ServerResponse } from "node:http"
import { compareVersions, getAnalysis, getNodeReason, getScenario, importScenario, listScenarios, runAnalysis, Store } from "./db"
import { comparisonBitDescription, comparisonVector, lexicographicOrder, NotFoundError, ValidationError, ConflictError } from "./domain"

const MAX_EXPORT_ROWS = 10_000

function readJson(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = ""
    let size = 0
    req.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new ValidationError("请求体超过 1 MiB 限制", { code: "PAYLOAD_TOO_LARGE" }))
        req.destroy()
        return
      }
      body += chunk.toString("utf8")
    })
    req.on("end", () => {
      try {
        resolve(body.length === 0 ? {} : JSON.parse(body))
      } catch {
        reject(new ValidationError("JSON 格式错误", { code: "MALFORMED_JSON" }))
      }
    })
    req.on("error", reject)
  })
}

function send(res: ServerResponse, status: number, value: unknown, contentType = "application/json; charset=utf-8") {
  const payload = contentType.startsWith("application/json") ? JSON.stringify(value, (_key, item) => typeof item === "bigint" ? `0x${item.toString(16).toUpperCase()}` : item, 2) : String(value)
  res.writeHead(status, { "content-type": contentType, "content-length": Buffer.byteLength(payload) })
  res.end(payload)
}

function csvEscape(value: unknown): string {
  const text = value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return ""
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))]
  return [headers.join(","), ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(","))].join("\r\n")
}

export function createApp(store: Store): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1")
      const path = url.pathname.replace(/^\/api\/v1/, "")
      const method = req.method ?? "GET"

      if (method === "GET" && (path === "/health" || path === "/health/")) {
        send(res, 200, { ok: true, rulesVersion: "classic-can-id-arbitration-v1.0" })
        return
      }
      if (method === "POST" && (path === "/scenarios" || path === "/scenarios/")) {
        const input = await readJson(req)
        const imported = importScenario(store, input)
        send(res, imported.reused ? 200 : 201, { scenarioId: imported.id, requestId: imported.scenario.requestId, version: imported.version, reused: imported.reused, scenario: imported.scenario })
        return
      }
      if (method === "GET" && (path === "/scenarios" || path === "/scenarios/")) {
        send(res, 200, { scenarios: listScenarios(store) })
        return
      }

      const scenarioMatch = path.match(/^\/scenarios\/([^/]+)(?:\/([^/]+))?(?:\/([^/]+))?\/?$/)
      if (scenarioMatch) {
        const id = decodeURIComponent(scenarioMatch[1])
        const action = scenarioMatch[2]
        const child = scenarioMatch[3]
        if (!action) {
          send(res, 200, getScenario(store, id))
          return
        }
        if (action === "vectors" && method === "GET") {
          const scenario = getScenario(store, id)
          send(res, 200, {
            scenarioId: scenario.id,
            version: scenario.version,
            vectors: scenario.nodes.map((node) => ({ node: node.name, vector: comparisonVector(node), bits: comparisonVector(node).map((bit) => bit.value).join("") })),
            lexicographicPriority: lexicographicOrder(scenario.nodes).map((node) => node.name),
          })
          return
        }
        if (action === "analysis" && !child && method === "POST") {
          const result = runAnalysis(store, id)
          send(res, result.reused ? 200 : 201, { scenarioId: result.scenarioId, version: result.version, ...result.result })
          return
        }
        if (action === "analysis" && !child && method === "GET") {
          const result = getAnalysis(store, id)
          send(res, 200, { scenarioId: result.scenarioId, version: result.version, ...result.result })
          return
        }
        if (action === "analysis" && child === "export" && method === "GET") {
          const result = getAnalysis(store, id)
          const format = url.searchParams.get("format") === "csv" ? "csv" : "json"
          if (format === "json") {
            send(res, 200, result)
            return
          }
          const rows = result.result.steps.flatMap((step) =>
            Object.entries(step.sent).map(([node, value]) => ({
              scenarioId: result.scenarioId,
              version: result.version,
              step: step.step,
              bitIndex: step.bitIndex,
              field: step.field,
              fieldPosition: step.fieldPosition,
              node,
              sent: value,
              bus: step.bus,
              eliminated: step.eliminated.includes(node),
              survived: step.survivors.includes(node),
            }))
          )
          if (rows.length > MAX_EXPORT_ROWS) {
            throw new ValidationError(`导出行数超过 ${MAX_EXPORT_ROWS} 行限制`, { code: "EXPORT_TOO_LARGE", rows: rows.length })
          }
          send(res, 200, toCsv(rows), "text/csv; charset=utf-8")
          return
        }
        if (action === "nodes" && child && method === "GET") {
          send(res, 200, getNodeReason(store, id, decodeURIComponent(child)))
          return
        }
        if (action === "versions" && method === "GET") {
          send(res, 200, { versions: compareVersions(store, id) })
          return
        }
      }

      send(res, 404, { error: { code: "NOT_FOUND", message: "接口不存在" } })
    } catch (error) {
      if (error instanceof ValidationError) send(res, 400, { error: { code: error.code, message: error.message, details: error.details } })
      else if (error instanceof ConflictError) send(res, 409, { error: { code: error.code, message: error.message, details: error.details } })
      else if (error instanceof NotFoundError) send(res, 404, { error: { code: error.code, message: error.message } })
      else {
        console.error(error)
        send(res, 500, { error: { code: "INTERNAL_ERROR", message: "服务器内部错误" } })
      }
    }
  })
}
