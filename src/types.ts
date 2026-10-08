export type FrameFormat = "standard" | "extended"
export type FrameType = "data" | "remote"

export interface NodeInput {
  name: string
  format: FrameFormat
  id: string
  frameType: FrameType
  dlc: number
  data?: string[]
}

export interface ScenarioInput {
  requestId: string
  scenarioKey?: string
  name?: string
  nodes: NodeInput[]
}

export interface NormalizedNode extends NodeInput {
  name: string
  idValue: bigint
  data: string[]
}

export interface NormalizedScenario {
  requestId: string
  scenarioKey?: string
  name: string
  nodes: NormalizedNode[]
}

export interface ComparisonBit {
  bitIndex: number
  value: 0 | 1
  field: "SOF" | "IDENTIFIER" | "RTR" | "SRR" | "IDE"
  fieldPosition: number
  sourceBit: number | null
}

export interface ArbitrationStep {
  step: number
  bitIndex: number
  field: string
  fieldPosition: number
  sourceBit: number | null
  bitByNode: Record<string, ComparisonBit>
  participantsBefore: string[]
  sent: Record<string, 0 | 1>
  bus: 0 | 1
  eliminated: string[]
  survivors: string[]
}

export type AnalysisOutcome = "winner" | "co_send" | "post_arbitration_conflict"

export interface AnalysisResult {
  rulesVersion: string
  outcome: AnalysisOutcome
  winner: string | null
  survivors: string[]
  eliminated: Array<{ node: string; step: number; reason: string }>
  steps: ArbitrationStep[]
  comparisonStoppedEarly: boolean
  uncomparedBits: ComparisonBit[]
  differences?: string[]
}

export interface ApiError {
  error: {
    code: string
    message: string
    details?: unknown
  }
}
