export type FrameFormat = "standard" | "extended";
export type FrameType = "data" | "remote";

export interface NodeInput {
  name: string;
  format: FrameFormat;
  id: string; // 十六进制字符串，如 "0x123" 或 "123"
  frameType: FrameType;
  dlc: number;
  data?: string; // 数据帧必填，偶数位十六进制；远程帧必须省略
}

export interface CanNode {
  name: string;
  format: FrameFormat;
  id: number; // 无符号整数，已按位数校验范围
  frameType: FrameType;
  dlc: number;
  data: number[]; // 远程帧为 []
}

export interface VectorBit {
  index: number; // 在比较向量中的位置（0 起，不含 SOF）
  bit: 0 | 1;
  field: "ID" | "RTR" | "SRR" | "IDE";
  fieldPos: number; // 字段内位置（0 起，最高位先发）
  idBit?: number; // 原标识来源位号（如标准帧 10..0，扩展帧 28..0）
}

export interface StepRecord {
  index: number; // 比较位序号（0 起，SOF 不参与）
  participants: string[];
  sent: Record<string, { bit: 0 | 1; field: string; fieldPos: number; idBit?: number }>;
  bus: 0 | 1;
  dropped: string[];
  survivors: string[];
}

export type RunStatus = "winner" | "co_transmit" | "post_arbitration_conflict";

export interface ConflictField {
  field: "dlc" | "data";
  values: Record<string, unknown>;
}

export interface RunResult {
  status: RunStatus;
  winners: string[]; // winner: 1 个；co_transmit: 全部；conflict: 全部并列者
  coTransmit: boolean;
  conflictFields?: ConflictField[];
  note?: string;
  steps: StepRecord[];
  totalComparedBits: number;
}

export interface Scenario {
  name: string;
  nodes: NodeInput[];
}

export const RULES_VERSION = "can-arb-v1";
export const MAX_NODES = 64;
export const MAX_EXPORT_ROWS = 1000;
