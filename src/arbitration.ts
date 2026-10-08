import {
  AnalysisResult,
  ArbitrationStep,
  ComparisonBit,
  FrameFormat,
  NormalizedNode,
  NormalizedScenario,
  NodeInput,
  ScenarioInput,
} from "./types"

export const RULES_VERSION = "classic-can-id-arbitration-v1.0"
export const MAX_NODES = 64
export const MAX_DLC = 8

export class ValidationError extends Error {
  code = "VALIDATION_ERROR"
  details: unknown
  constructor(message: string, details?: unknown) {
    super(message)
    this.details = details
  }
}

export class NotFoundError extends Error {
  code = "NOT_FOUND"
  constructor(message: string) {
    super(message)
  }
}

export class ConflictError extends Error {
  code = "IDEMPOTENCY_CONFLICT"
  details: unknown
  constructor(message: string, details?: unknown) {
    super(message)
    this.details = details
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function requireField(obj: Record<string, unknown>, key: keyof NodeInput, nodeLabel: string) {
  if (obj[key] === undefined || obj[key] === null) {
    throw new ValidationError(`节点 ${nodeLabel} 缺少字段 ${String(key)}`, { field: key })
  }
  return obj[key]
}

function parseHexId(raw: unknown, format: FrameFormat, nodeName: string): bigint {
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]+$/.test(raw)) {
    throw new ValidationError(`节点 ${nodeName} 的标识必须是 0x 开头的十六进制字符串`, { field: "id" })
  }
  let value: bigint
  try {
    value = BigInt(raw)
  } catch {
    throw new ValidationError(`节点 ${nodeName} 的标识无法解析`, { field: "id" })
  }
  const max = format === "standard" ? 0x7ffn : 0x1fffffffn
  if (value < 0n || value > max) {
    throw new ValidationError(`节点 ${nodeName} 的标识超出 ${format} 帧范围`, {
      field: "id",
      max: format === "standard" ? "0x7FF" : "0x1FFFFFFF",
    })
  }
  return value
}

function parseByte(raw: unknown, index: number, nodeName: string): string {
  if (typeof raw !== "string" || !/^(?:[0-9a-fA-F]{2})$/.test(raw)) {
    throw new ValidationError(`节点 ${nodeName} 的数据字节 ${index} 必须是两位规范十六进制`, {
      field: "data",
      index,
    })
  }
  return raw.toUpperCase()
}

export function validateScenario(input: unknown): NormalizedScenario {
  if (!isRecord(input)) {
    throw new ValidationError("场景必须是 JSON 对象")
  }
  if (typeof input.requestId !== "string" || input.requestId.trim().length === 0) {
    throw new ValidationError("requestId 必须是非空字符串", { field: "requestId" })
  }
  if (input.name !== undefined && (typeof input.name !== "string" || input.name.trim().length === 0)) {
    throw new ValidationError("场景名称必须是非空字符串", { field: "name" })
  }
  if (input.scenarioKey !== undefined && (typeof input.scenarioKey !== "string" || !/^[A-Za-z0-9_.:-]{1,100}$/.test(input.scenarioKey))) {
    throw new ValidationError("scenarioKey 必须是 1 到 100 个字母、数字、下划线、点、冒号或短横线", { field: "scenarioKey" })
  }
  if (!Array.isArray(input.nodes)) {
    throw new ValidationError("nodes 必须是数组", { field: "nodes" })
  }
  if (input.nodes.length === 0) {
    throw new ValidationError("至少需要一个参与节点", { field: "nodes" })
  }
  if (input.nodes.length > MAX_NODES) {
    throw new ValidationError(`参与节点数不能超过 ${MAX_NODES}`, { field: "nodes" })
  }

  const names = new Set<string>()
  const nodes = input.nodes.map((rawNode, index) => {
    const label = `#${index + 1}`
    if (!isRecord(rawNode)) throw new ValidationError(`节点 ${label} 必须是对象`)
    const name = requireField(rawNode, "name", label)
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new ValidationError(`节点 ${label} 的 name 必须是非空字符串`, { field: "name" })
    }
    if (names.has(name)) {
      throw new ValidationError(`节点名称重复: ${name}`, { field: "name" })
    }
    names.add(name)

    const format = requireField(rawNode, "format", name)
    if (format !== "standard" && format !== "extended") {
      throw new ValidationError(`节点 ${name} 的 format 必须是 standard 或 extended`, { field: "format" })
    }
    const idRaw = requireField(rawNode, "id", name)
    const idValue = parseHexId(idRaw, format, name)

    const frameType = requireField(rawNode, "frameType", name)
    if (frameType !== "data" && frameType !== "remote") {
      throw new ValidationError(`节点 ${name} 的 frameType 必须是 data 或 remote`, { field: "frameType" })
    }

    const dlcRaw = requireField(rawNode, "dlc", name)
    if (typeof dlcRaw !== "number" || !Number.isInteger(dlcRaw) || dlcRaw < 0 || dlcRaw > MAX_DLC) {
      throw new ValidationError(`节点 ${name} 的 DLC 必须是 0 到 8 的整数`, { field: "dlc" })
    }

    if (rawNode.data !== undefined && !Array.isArray(rawNode.data)) {
      throw new ValidationError(`节点 ${name} 的 data 必须是字节数组`, { field: "data" })
    }
    const rawData = rawNode.data ?? []
    if (frameType === "data" && rawData.length !== dlcRaw) {
      throw new ValidationError(`节点 ${name} 的数据帧字节数必须等于 DLC`, {
        field: "data",
        expected: dlcRaw,
        actual: rawData.length,
      })
    }
    if (frameType === "remote" && rawData.length !== 0) {
      throw new ValidationError(`节点 ${name} 的远程帧不能携带载荷`, { field: "data" })
    }
    const data = rawData.map((byte, byteIndex) => parseByte(byte, byteIndex, name))

    const node: NodeInput = { name, format, id: (idRaw as string).toUpperCase().replace(/^0X/, "0x"), frameType, dlc: dlcRaw, data }
    return { ...node, idValue, data }
  })

  return {
    requestId: input.requestId,
    scenarioKey: input.scenarioKey,
    name: typeof input.name === "string" ? input.name : "未命名场景",
    nodes,
  }
}

function bit(value: bigint, position: number): 0 | 1 {
  return ((value >> BigInt(position)) & 1n) === 1n ? 1 : 0
}

export function comparisonVector(node: NormalizedNode): ComparisonBit[] {
  const bits: ComparisonBit[] = [{ bitIndex: 0, value: 0, field: "SOF", fieldPosition: 1, sourceBit: null }]
  if (node.format === "standard") {
    for (let position = 10; position >= 0; position -= 1) {
      bits.push({ bitIndex: bits.length, value: bit(node.idValue, position), field: "IDENTIFIER", fieldPosition: 10 - position + 1, sourceBit: position })
    }
    bits.push({ bitIndex: bits.length, value: node.frameType === "data" ? 0 : 1, field: "RTR", fieldPosition: 1, sourceBit: null })
    bits.push({ bitIndex: bits.length, value: 0, field: "IDE", fieldPosition: 1, sourceBit: null })
    return bits
  }

  const base = node.idValue >> 18n
  const extension = node.idValue & 0x3ffffn
  for (let position = 10; position >= 0; position -= 1) {
    bits.push({ bitIndex: bits.length, value: bit(base, position), field: "IDENTIFIER", fieldPosition: 10 - position + 1, sourceBit: 28 - (10 - position) })
  }
  bits.push({ bitIndex: bits.length, value: 1, field: "SRR", fieldPosition: 1, sourceBit: null })
  bits.push({ bitIndex: bits.length, value: 1, field: "IDE", fieldPosition: 1, sourceBit: null })
  for (let position = 17; position >= 0; position -= 1) {
    bits.push({ bitIndex: bits.length, value: bit(extension, position), field: "IDENTIFIER", fieldPosition: 29 - position, sourceBit: position })
  }
  bits.push({ bitIndex: bits.length, value: node.frameType === "data" ? 0 : 1, field: "RTR", fieldPosition: 1, sourceBit: null })
  return bits
}

function vectorKey(node: NormalizedNode): string {
  return comparisonVector(node).map((item) => String(item.value)).join("")
}

function describeBit(meta: ComparisonBit): string {
  if (meta.field === "IDENTIFIER") return `标识第 ${meta.fieldPosition} 位`
  return `${meta.field} 位`
}

export function analyze(scenario: NormalizedScenario): AnalysisResult {
  const vectors = new Map(scenario.nodes.map((node) => [node.name, comparisonVector(node)]))
  let alive = scenario.nodes.map((node) => node.name)
  const steps: ArbitrationStep[] = []
  const eliminated: AnalysisResult["eliminated"] = []
  const maxLength = Math.max(...[...vectors.values()].map((vector) => vector.length))
  let stoppedEarly = false
  let uncompared: ComparisonBit[] = []

  for (let bitIndex = 0; bitIndex < maxLength; bitIndex += 1) {
    if (alive.length <= 1) {
      stoppedEarly = true
      const winner = scenario.nodes.find((node) => node.name === alive[0])
      uncompared = winner ? comparisonVector(winner).slice(bitIndex) : []
      break
    }

    const current = alive
    const sent: Record<string, 0 | 1> = {}
    for (const name of current) {
      const vector = vectors.get(name)!
      sent[name] = bitIndex < vector.length ? vector[bitIndex].value : 1
    }
    const bus: 0 | 1 = Object.values(sent).every((value) => value === 1) ? 1 : 0
    const losers = current.filter((name) => sent[name] === 1 && bus === 0)
    const survivors = current.filter((name) => !losers.includes(name))
    const bitByNode = Object.fromEntries(current.map((name) => [name, vectors.get(name)![bitIndex]]))
    const fieldNames = [...new Set(Object.values(bitByNode).map((meta) => meta.field))]
    const metaSource = vectors.get(current[0])![bitIndex]

    steps.push({
      step: steps.length + 1,
      bitIndex,
      field: fieldNames.length === 1 ? metaSource.field : fieldNames.join("/"),
      fieldPosition: metaSource.fieldPosition,
      sourceBit: metaSource.sourceBit,
      bitByNode,
      participantsBefore: current,
      sent,
      bus,
      eliminated: losers,
      survivors,
    })
    for (const loser of losers) {
      const loserBit = bitByNode[loser]
      eliminated.push({
        node: loser,
        step: steps.length,
        reason: `在第 ${bitIndex} 位（${describeBit(loserBit)}）发送隐性 1，但总线为显性 0；基于本位步前集合同时淘汰。`,
      })
    }
    alive = survivors
  }

  const survivors = alive
  let outcome: AnalysisResult["outcome"]
  let winner: string | null = null
  let differences: string[] | undefined
  if (survivors.length === 1) {
    outcome = "winner"
    winner = survivors[0]
  } else {
    const survivorNodes = scenario.nodes.filter((node) => survivors.includes(node.name))
    const first = survivorNodes[0]
    const same = survivorNodes.every((node) =>
      node.format === first.format &&
      node.idValue === first.idValue &&
      node.frameType === first.frameType &&
      node.dlc === first.dlc &&
      JSON.stringify(node.data) === JSON.stringify(first.data)
    )
    outcome = same ? "co_send" : "post_arbitration_conflict"
    if (!same) {
      differences = []
      if (survivorNodes.some((node) => node.format !== first.format || node.idValue !== first.idValue || node.frameType !== first.frameType)) {
        differences.push("仲裁比较向量之外或记录不一致的格式/标识/帧类型差异")
      }
      if (survivorNodes.some((node) => node.dlc !== first.dlc)) differences.push("DLC 不同")
      if (survivorNodes.some((node) => JSON.stringify(node.data) !== JSON.stringify(first.data))) differences.push("数据载荷不同")
    }
  }

  return { rulesVersion: RULES_VERSION, outcome, winner, survivors, eliminated, steps, comparisonStoppedEarly: stoppedEarly, uncomparedBits: uncompared, differences }
}

export function lexicographicOrder(nodes: NormalizedNode[]): NormalizedNode[] {
  return [...nodes].sort((a, b) => {
    const va = vectorKey(a)
    const vb = vectorKey(b)
    return va < vb ? -1 : va > vb ? 1 : a.name.localeCompare(b.name)
  })
}
