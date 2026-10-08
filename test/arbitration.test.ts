import { test } from "node:test";
import assert from "node:assert/strict";
import { arbitrate } from "../src/arbitrate.js";
import { buildVector, compareVectors } from "../src/vector.js";
import { toCanNodes, validateScenario } from "../src/validate.js";
import { ApiError } from "../src/errors.js";
import { CanNode } from "../src/types.js";

function node(partial: Partial<CanNode> & { name: string }): CanNode {
  return { format: "standard", id: 0, frameType: "data", dlc: 0, data: [], ...partial };
}

test("混合场景：标准数据帧在 RTR/SRR 位胜出", () => {
  const nodes = [
    node({ name: "std-data", id: 0x123 }),
    node({ name: "std-remote", id: 0x123, frameType: "remote" }),
    node({ name: "ext", format: "extended", id: 0x048c0000 }),
  ];
  const r = arbitrate(nodes);
  assert.equal(r.status, "winner");
  assert.deepEqual(r.winners, ["std-data"]);
  // std-remote 与 ext 在位 11（RTR/SRR）发送 1，std-data 发送 0
  const step11 = r.steps[11];
  assert.equal(step11.bus, 0);
  assert.deepEqual(step11.dropped.sort(), ["ext", "std-remote"]);
});

test("移除标准数据帧后：标准远程帧在 IDE 位战胜扩展帧", () => {
  const nodes = [
    node({ name: "std-remote", id: 0x123, frameType: "remote" }),
    node({ name: "ext", format: "extended", id: 0x048c0000 }),
  ];
  const r = arbitrate(nodes);
  assert.deepEqual(r.winners, ["std-remote"]);
  const step12 = r.steps[12];
  assert.equal(step12.sent["std-remote"].field, "IDE");
  assert.equal(step12.sent["ext"].field, "IDE");
  assert.deepEqual(step12.dropped, ["ext"]);
});

test("同标识同载荷：共同发送同一帧", () => {
  const nodes = [
    node({ name: "a", id: 0x100, dlc: 2, data: [0x0a, 0x0b] }),
    node({ name: "b", id: 0x100, dlc: 2, data: [0x0a, 0x0b] }),
  ];
  const r = arbitrate(nodes);
  assert.equal(r.status, "co_transmit");
  assert.deepEqual(r.winners.sort(), ["a", "b"]);
});

test("同标识异载荷：post_arbitration_conflict 且只定位 data 差异", () => {
  const nodes = [
    node({ name: "a", id: 0x100, dlc: 2, data: [0x0a, 0x0b] }),
    node({ name: "b", id: 0x100, dlc: 2, data: [0x0a, 0x0c] }),
  ];
  const r = arbitrate(nodes);
  assert.equal(r.status, "post_arbitration_conflict");
  assert.deepEqual(r.conflictFields!.map((f) => f.field), ["data"]);
});

test("同标识异 DLC：冲突定位 dlc 与 data", () => {
  const nodes = [
    node({ name: "a", id: 0x100, dlc: 1, data: [0x0a] }),
    node({ name: "b", id: 0x100, dlc: 2, data: [0x0a, 0x0b] }),
  ];
  const r = arbitrate(nodes);
  assert.equal(r.status, "post_arbitration_conflict");
  assert.deepEqual(r.conflictFields!.map((f) => f.field), ["dlc", "data"]);
});

test("边界：标准 ID 0 胜 0x7FF；扩展最大值；低 18 位差异", () => {
  const r1 = arbitrate([node({ name: "lo", id: 0 }), node({ name: "hi", id: 0x7ff })]);
  assert.deepEqual(r1.winners, ["lo"]);
  const maxExt = 0x1fffffff;
  const r2 = arbitrate([
    node({ name: "ext-max", format: "extended", id: maxExt }),
    node({ name: "std-max", id: 0x7ff }),
  ]);
  assert.deepEqual(r2.winners, ["std-max"]); // 扩展帧 SRR/IDE 隐性必输
  // 低 18 位差异：高 11 位相同，扩展帧之间在低位段分出胜负
  const r3 = arbitrate([
    node({ name: "e1", format: "extended", id: 0x048c0001 }),
    node({ name: "e2", format: "extended", id: 0x048c0002 }),
  ]);
  assert.deepEqual(r3.winners, ["e1"]);
  const last = r3.steps[r3.steps.length - 1];
  assert.equal(last.sent["e1"].idBit, 1); // 位 1 处分歧：e1 发 0，e2 发 1
});

test("单节点直接获胜，无比较步", () => {
  const r = arbitrate([node({ name: "solo", id: 5 })]);
  assert.equal(r.status, "winner");
  assert.equal(r.steps.length, 0);
});

test("节点顺序置换不改变结果", () => {
  const mk = (): CanNode[] => [
    node({ name: "a", id: 0x10 }),
    node({ name: "b", id: 0x05 }),
    node({ name: "c", format: "extended", id: 0x00005 }),
    node({ name: "d", id: 0x10, frameType: "remote" }),
  ];
  const base = arbitrate(mk());
  const rev = arbitrate(mk().reverse());
  assert.deepEqual(rev.winners, base.winners);
  assert.equal(rev.status, base.status);
  assert.deepEqual(
    rev.steps.map((s) => [...s.dropped].sort()),
    base.steps.map((s) => [...s.dropped].sort())
  );
});

test("字典序核对：逐位仲裁结果与比较向量排序一致", () => {
  const nodes = [
    node({ name: "n1", id: 0x123 }),
    node({ name: "n2", id: 0x123, frameType: "remote" }),
    node({ name: "n3", format: "extended", id: 0x048c0000 }),
    node({ name: "n4", format: "extended", id: 0x048c0001 }),
    node({ name: "n5", id: 0x000 }),
  ];
  const r = arbitrate(nodes);
  const sorted = [...nodes].sort((a, b) => compareVectors(buildVector(a), buildVector(b)));
  assert.equal(r.winners[0], sorted[0].name);
  // 核对每个被淘汰节点的第一处分歧位
  for (const step of r.steps) {
    for (const loser of step.dropped) {
      const winnerVec = buildVector(nodes.find((n) => step.survivors.includes(n.name) || n.name === r.winners[0])!);
      const loserVec = buildVector(nodes.find((n) => n.name === loser)!);
      const firstDiff = loserVec.findIndex((b, i) => winnerVec[i] && b.bit !== winnerVec[i].bit);
      assert.equal(step.index, firstDiff, `节点 ${loser} 的第一处分歧应在位 ${firstDiff}`);
    }
  }
});

test("校验：非法 DLC、超范围 ID、重复节点、缺字段均拒绝", () => {
  assert.throws(() => validateScenario({ name: "s", nodes: [{ name: "a", format: "standard", id: "0x1", frameType: "data", dlc: 9, data: "00" }] }), (e: unknown) => e instanceof ApiError && e.code === "E_DLC_RANGE");
  assert.throws(() => validateScenario({ name: "s", nodes: [{ name: "a", format: "standard", id: "0x800", frameType: "remote", dlc: 0 }] }), (e: unknown) => e instanceof ApiError && e.code === "E_ID_RANGE");
  assert.throws(() => validateScenario({ name: "s", nodes: [{ name: "a", format: "extended", id: "0x20000000", frameType: "remote", dlc: 0 }] }), (e: unknown) => e instanceof ApiError && e.code === "E_ID_RANGE");
  assert.throws(
    () => validateScenario({ name: "s", nodes: [
      { name: "a", format: "standard", id: "0x1", frameType: "remote", dlc: 0 },
      { name: "a", format: "standard", id: "0x2", frameType: "remote", dlc: 0 },
    ] }),
    (e: unknown) => e instanceof ApiError && e.code === "E_DUPLICATE_NODE"
  );
  assert.throws(() => validateScenario({ name: "s", nodes: [{ name: "a", format: "standard", frameType: "data", dlc: 1, data: "00" }] }), (e: unknown) => e instanceof ApiError && e.code === "E_MISSING_FIELD");
  assert.throws(() => validateScenario({ name: "s", nodes: [{ name: "a", format: "standard", id: "0x1", frameType: "data", dlc: 2, data: "00" }] }), (e: unknown) => e instanceof ApiError && e.code === "E_DATA_LENGTH");
  assert.throws(() => validateScenario({ name: "s", nodes: [{ name: "a", format: "standard", id: "0x1", frameType: "remote", dlc: 4, data: "00" }] }), (e: unknown) => e instanceof ApiError && e.code === "E_REMOTE_PAYLOAD");
  assert.throws(() => validateScenario({ name: "s", nodes: [{ name: "a", format: "standard", id: "zz", frameType: "remote", dlc: 0 }] }), (e: unknown) => e instanceof ApiError && e.code === "E_BAD_HEX");
});

test("比较向量字段与来源位标注正确", () => {
  const ext = buildVector(node({ name: "e", format: "extended", id: 0x048c0000 }));
  assert.equal(ext.length, 32);
  assert.equal(ext[0].idBit, 28);
  assert.equal(ext[11].field, "SRR");
  assert.equal(ext[12].field, "IDE");
  assert.equal(ext[13].idBit, 17);
  assert.equal(ext[31].field, "RTR");
  const std = buildVector(node({ name: "s", id: 0x123 }));
  assert.equal(std.length, 13);
  assert.deepEqual([std[11].field, std[12].field], ["RTR", "IDE"]);
});
