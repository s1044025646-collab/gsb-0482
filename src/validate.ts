import { ApiError } from "./errors.js";
import { CanNode, FrameFormat, FrameType, MAX_NODES, NodeInput, Scenario } from "./types.js";

const HEX_RE = /^(0x)?[0-9a-fA-F]+$/;
const DATA_HEX_RE = /^(0x)?([0-9a-fA-F]{2})+$/;

function requireField(obj: Record<string, unknown>, field: string, nodeIdx: number): unknown {
  const v = obj[field];
  if (v === undefined || v === null || v === "") {
    throw new ApiError("E_MISSING_FIELD", `节点 #${nodeIdx} 缺少字段 "${field}"`, { nodeIdx, field });
  }
  return v;
}

export function parseIdHex(raw: unknown, format: FrameFormat, nodeIdx: number): number {
  if (typeof raw !== "string" || !HEX_RE.test(raw)) {
    throw new ApiError("E_BAD_HEX", `节点 #${nodeIdx} 的标识不是合法十六进制字符串: ${String(raw)}`);
  }
  const value = parseInt(raw.replace(/^0x/i, ""), 16);
  const max = format === "standard" ? 0x7ff : 0x1fffffff;
  if (!Number.isSafeInteger(value) || value > max) {
    throw new ApiError(
      "E_ID_RANGE",
      `节点 #${nodeIdx} 标识 0x${value.toString(16).toUpperCase()} 超出 ${format === "standard" ? "11" : "29"} 位范围（最大 0x${max.toString(16).toUpperCase()}），不允许截断高位`,
      { nodeIdx, id: raw, max }
    );
  }
  return value;
}

export function parseDataHex(raw: string, nodeIdx: number): number[] {
  if (!DATA_HEX_RE.test(raw)) {
    throw new ApiError("E_BAD_HEX", `节点 #${nodeIdx} 的数据不是偶数位十六进制: ${raw}`);
  }
  const hex = raw.replace(/^0x/i, "");
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  return bytes;
}

export function validateNode(raw: unknown, nodeIdx: number): CanNode {
  if (typeof raw !== "object" || raw === null) {
    throw new ApiError("E_BAD_REQUEST", `节点 #${nodeIdx} 不是对象`);
  }
  const obj = raw as Record<string, unknown>;
  const name = requireField(obj, "name", nodeIdx);
  if (typeof name !== "string" || name.trim() === "") {
    throw new ApiError("E_BAD_REQUEST", `节点 #${nodeIdx} 的 name 必须是非空字符串`);
  }
  const format = requireField(obj, "format", nodeIdx) as FrameFormat;
  if (format !== "standard" && format !== "extended") {
    throw new ApiError("E_BAD_FORMAT", `节点 "${name}" 的 format 必须是 standard 或 extended`);
  }
  const frameType = requireField(obj, "frameType", nodeIdx) as FrameType;
  if (frameType !== "data" && frameType !== "remote") {
    throw new ApiError("E_BAD_FRAME_TYPE", `节点 "${name}" 的 frameType 必须是 data 或 remote`);
  }
  const id = parseIdHex(requireField(obj, "id", nodeIdx), format, nodeIdx);
  const dlcRaw = requireField(obj, "dlc", nodeIdx);
  if (typeof dlcRaw !== "number" || !Number.isInteger(dlcRaw) || dlcRaw < 0 || dlcRaw > 8) {
    throw new ApiError("E_DLC_RANGE", `节点 "${name}" 的 DLC 必须是 0..8 的整数，得到 ${String(dlcRaw)}`);
  }
  let data: number[] = [];
  if (frameType === "data") {
    const dataRaw = requireField(obj, "data", nodeIdx);
    if (typeof dataRaw !== "string") {
      throw new ApiError("E_BAD_HEX", `节点 "${name}" 的 data 必须是十六进制字符串`);
    }
    data = parseDataHex(dataRaw, nodeIdx);
    if (data.length !== dlcRaw) {
      throw new ApiError(
        "E_DATA_LENGTH",
        `节点 "${name}" 数据帧字节数 ${data.length} 与 DLC ${dlcRaw} 不一致`,
        { node: name, dlc: dlcRaw, bytes: data.length }
      );
    }
  } else if (obj.data !== undefined && obj.data !== null && obj.data !== "") {
    throw new ApiError("E_REMOTE_PAYLOAD", `远程帧节点 "${name}" 不允许携带数据载荷`);
  }
  return { name, format, id, frameType, dlc: dlcRaw, data };
}

export function validateScenario(raw: unknown): Scenario & { nodes: NodeInput[] } {
  if (typeof raw !== "object" || raw === null) {
    throw new ApiError("E_BAD_REQUEST", "场景必须是对象");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.name !== "string" || obj.name.trim() === "") {
    throw new ApiError("E_MISSING_FIELD", "场景缺少非空 name 字段", { field: "name" });
  }
  if (!Array.isArray(obj.nodes)) {
    throw new ApiError("E_MISSING_FIELD", "场景缺少 nodes 数组", { field: "nodes" });
  }
  if (obj.nodes.length === 0) {
    throw new ApiError("E_EMPTY_SCENARIO", "场景至少需要一个节点");
  }
  if (obj.nodes.length > MAX_NODES) {
    throw new ApiError("E_TOO_MANY_NODES", `节点数 ${obj.nodes.length} 超过上限 ${MAX_NODES}`);
  }
  const seen = new Set<string>();
  for (let i = 0; i < obj.nodes.length; i++) {
    const n = obj.nodes[i] as Record<string, unknown>;
    const nm = n && typeof n === "object" ? n.name : undefined;
    if (typeof nm === "string") {
      if (seen.has(nm)) {
        throw new ApiError("E_DUPLICATE_NODE", `节点名称重复: "${nm}"，整个场景被拒绝`);
      }
      seen.add(nm);
    }
    validateNode(n, i); // 提前校验，任何节点有问题都拒绝整个场景
  }
  return { name: obj.name, nodes: obj.nodes as NodeInput[] };
}

export function toCanNodes(scenario: Scenario): CanNode[] {
  return scenario.nodes.map((n, i) => validateNode(n, i));
}
