import { buildVector } from "./vector.js";
import { CanNode, ConflictField, RunResult, StepRecord, VectorBit } from "./types.js";

function sameFrame(a: CanNode, b: CanNode): boolean {
  return (
    a.format === b.format &&
    a.id === b.id &&
    a.frameType === b.frameType &&
    a.dlc === b.dlc &&
    a.data.length === b.data.length &&
    a.data.every((v, i) => v === b.data[i])
  );
}

function conflictFields(survivors: CanNode[]): ConflictField[] {
  const fields: ConflictField[] = [];
  const dlcs = new Map(survivors.map((n) => [n.name, n.dlc]));
  if (new Set(dlcs.values()).size > 1) {
    fields.push({ field: "dlc", values: Object.fromEntries(dlcs) });
  }
  const dataMap = new Map(
    survivors.map((n) => [n.name, n.data.map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ")])
  );
  if (new Set(dataMap.values()).size > 1) {
    fields.push({ field: "data", values: Object.fromEntries(dataMap) });
  }
  return fields;
}

/**
 * 逐位仲裁：每一步基于同一个步前存活集合同时淘汰。
 * 总线值 = 所有参与者发送位的逻辑与（0 显性优先）。
 */
export function arbitrate(nodes: CanNode[]): RunResult {
  const vectors = new Map<string, VectorBit[]>(nodes.map((n) => [n.name, buildVector(n)]));
  const steps: StepRecord[] = [];
  let survivors = nodes.map((n) => n.name);
  const maxLen = Math.max(...[...vectors.values()].map((v) => v.length));

  for (let index = 0; index < maxLen && survivors.length > 1; index++) {
    // 参与者 = 在该位置仍有比较位的存活节点
    const participants = survivors.filter((name) => index < vectors.get(name)!.length);
    if (participants.length <= 1) break;
    const sent: StepRecord["sent"] = {};
    let bus: 0 | 1 = 1;
    for (const name of participants) {
      const vb = vectors.get(name)![index];
      sent[name] = { bit: vb.bit, field: vb.field, fieldPos: vb.fieldPos, ...(vb.idBit !== undefined ? { idBit: vb.idBit } : {}) };
      bus = (bus & vb.bit) as 0 | 1;
    }
    const dropped = participants.filter((name) => sent[name].bit === 1 && bus === 0);
    const nextSurvivors = survivors.filter((name) => !dropped.includes(name));
    steps.push({ index, participants, sent, bus, dropped, survivors: nextSurvivors });
    survivors = nextSurvivors;
  }

  const totalComparedBits = steps.length;
  const survivorNodes = nodes.filter((n) => survivors.includes(n.name));

  if (survivorNodes.length === 1) {
    return {
      status: "winner",
      winners: [survivorNodes[0].name],
      coTransmit: false,
      note: `节点 "${survivorNodes[0].name}" 在第 ${totalComparedBits} 个比较位后成为唯一存活者，后续位不再参与仲裁比较`,
      steps,
      totalComparedBits,
    };
  }

  const first = survivorNodes[0];
  const allSame = survivorNodes.every((n) => sameFrame(first, n));
  if (allSame) {
    return {
      status: "co_transmit",
      winners: survivors,
      coTransmit: true,
      note: `${survivors.length} 个节点的格式、完整标识、帧类型、DLC 与数据完全一致，共同发送同一帧，全部保留身份`,
      steps,
      totalComparedBits,
    };
  }
  return {
    status: "post_arbitration_conflict",
    winners: survivors,
    coTransmit: false,
    conflictFields: conflictFields(survivorNodes),
    note: "仲裁位完全相同，但 DLC 或载荷不同：仲裁无法区分，后续发送冲突，不指定任何节点成功",
    steps,
    totalComparedBits,
  };
}
