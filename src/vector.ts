import { CanNode, VectorBit } from "./types.js";

/**
 * 生成含 IDE 的比较向量（不含 SOF；SOF 各节点相同，可展示但不参与比较）。
 * 标准帧：ID10..0, RTR, IDE=0
 * 扩展帧：ID28..18, SRR=1, IDE=1, ID17..0, RTR
 */
export function buildVector(node: CanNode): VectorBit[] {
  const bits: VectorBit[] = [];
  const push = (bit: 0 | 1, field: VectorBit["field"], fieldPos: number, idBit?: number) =>
    bits.push({ index: bits.length, bit, field, fieldPos, idBit });

  if (node.format === "standard") {
    for (let pos = 0; pos < 11; pos++) {
      const idBit = 10 - pos;
      push(((node.id >> idBit) & 1) as 0 | 1, "ID", pos, idBit);
    }
    push(node.frameType === "remote" ? 1 : 0, "RTR", 0);
    push(0, "IDE", 0);
  } else {
    for (let pos = 0; pos < 11; pos++) {
      const idBit = 28 - pos;
      push(((node.id >> idBit) & 1) as 0 | 1, "ID", pos, idBit);
    }
    push(1, "SRR", 0);
    push(1, "IDE", 0);
    for (let pos = 0; pos < 18; pos++) {
      const idBit = 17 - pos;
      push(((node.id >> idBit) & 1) as 0 | 1, "ID", pos, idBit);
    }
    push(node.frameType === "remote" ? 1 : 0, "RTR", 0);
  }
  return bits;
}

/** 字典序（0<1）比较两个向量的优先级，用于独立核对逐位仲裁结果。 */
export function compareVectors(a: VectorBit[], b: VectorBit[]): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i].bit !== b[i].bit) return a[i].bit - b[i].bit;
  }
  return a.length - b.length;
}
