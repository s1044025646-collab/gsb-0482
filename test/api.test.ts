import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "../src/server.js";

let base = "";
let close: () => void;

before(async () => {
  const srv = await startServer(0, ":memory:");
  base = `http://127.0.0.1:${srv.port}`;
  close = srv.close;
});
after(() => close());

async function post(path: string, body: unknown, key?: string) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const scenario = {
  name: "api-demo",
  nodes: [
    { name: "std-data", format: "standard", id: "0x123", frameType: "data", dlc: 2, data: "AA55" },
    { name: "std-remote", format: "standard", id: "0x123", frameType: "remote", dlc: 2 },
    { name: "ext", format: "extended", id: "0x048C0000", frameType: "data", dlc: 1, data: "01" },
  ],
};

test("API 全流程：导入→向量→仲裁→淘汰原因→版本→导出", async () => {
  const imp = await post("/scenarios", scenario, "k1");
  assert.equal(imp.status, 201);
  assert.equal(imp.body.version, 1);
  const replay = await post("/scenarios", scenario, "k1");
  assert.equal(replay.body.replayed, true);

  const vec = await (await fetch(`${base}/scenarios/api-demo/vector`)).json();
  assert.equal(vec.vectors.length, 3);
  assert.equal(vec.vectors[2].bits[11].field, "SRR");

  const run = await post("/scenarios/api-demo/arbitrate", {}, "k2");
  assert.equal(run.body.status, "winner");
  assert.deepEqual(run.body.winners, ["std-data"]);

  const why = await (await fetch(`${base}/runs/${run.body.runId}/nodes/std-remote`)).json();
  assert.equal(why.eliminated, true);
  assert.equal(why.atBit, 11);
  assert.equal(why.field, "RTR");

  // 修改标识 → 新版本，旧版本不变
  const v2 = { ...scenario, nodes: scenario.nodes.map((n, i) => (i === 0 ? { ...n, id: "0x124" } : n)) };
  const imp2 = await post("/scenarios", v2);
  assert.equal(imp2.body.version, 2);
  const versions = await (await fetch(`${base}/scenarios/api-demo/versions`)).json();
  assert.deepEqual(versions.versions.map((v: { version: number }) => v.version), [1, 2]);
  const diff = await (await fetch(`${base}/scenarios/api-demo/diff?a=1&b=2`)).json();
  assert.equal(diff.changed.length, 1);
  const oldRun = await post("/scenarios/api-demo/arbitrate?version=1", {});
  assert.deepEqual(oldRun.body.winners, ["std-data"]);

  const csv = await (await fetch(`${base}/runs/${run.body.runId}/export?format=csv`)).text();
  assert.match(csv, /^bit_index,node,sent_bit/);
  const json = await (await fetch(`${base}/runs/${run.body.runId}/export?format=json`)).json();
  assert.equal(json.steps.length, run.body.totalComparedBits);
});

test("API 校验错误返回结构化错误码", async () => {
  const bad = await post("/scenarios", { name: "bad", nodes: [{ name: "x", format: "standard", id: "0x1", frameType: "data", dlc: 9, data: "00" }] });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, "E_DLC_RANGE");
  const missing = await fetch(`${base}/scenarios/nope/vector`);
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error.code, "E_NOT_FOUND");
});
