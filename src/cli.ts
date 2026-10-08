import { readFileSync, writeFileSync } from "node:fs";
import { defaultDbPath, Store } from "./db.js";
import { errorBody } from "./errors.js";
import { diffVersions, eliminationReason, exportRun, getRun, getVectors, importScenario, runArbitration } from "./service.js";
import { StepRecord } from "./types.js";

const USAGE = `CAN 逐位仲裁 CLI
用法: node dist/cli.js <命令> [参数]
  import <file.json> [--key=K]     导入场景（内容变化自动创建新版本）
  versions <name>                  查看场景版本
  vector <name> [--version=N]      查看各帧比较向量
  run <name> [--version=N] [--key=K]  运行逐位仲裁
  show <runId>                     查看运行结果与逐步记录
  why <runId> <node>               查询某节点淘汰原因
  diff <name> <verA> <verB>        对照两个场景版本
  export <runId> [json|csv] [file] 导出运行记录
  demo                             运行内置演示场景
环境变量: CAN_ARB_DB 指定数据库路径（默认 ./data/can-arb.db）
`;

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

/** 对齐的 0/1 列展示每一步：决定胜负的位置以 * 标注 */
export function renderSteps(steps: StepRecord[], nodeOrder?: string[]): string {
  const names = nodeOrder ?? [...new Set(steps.flatMap((s) => s.participants))];
  const width = Math.max(4, ...names.map((n) => n.length)) + 1;
  const lines: string[] = [];
  lines.push(pad("bit", 5) + names.map((n) => pad(n, width)).join("") + "bus 淘汰");
  for (const s of steps) {
    const decisive = s.dropped.length > 0 ? "*" : " ";
    let row = pad(String(s.index), 4) + decisive;
    for (const n of names) {
      const info = s.sent[n];
      row += pad(info ? String(info.bit) : "·", width);
    }
    row += pad(String(s.bus), 4) + (s.dropped.length ? s.dropped.join(",") : "-");
    lines.push(row);
  }
  return lines.join("\n");
}

function renderVectorTable(vectors: ReturnType<typeof getVectors>): string {
  const lines: string[] = [];
  for (const v of vectors.vectors) {
    const bits = v.bits.map((b) => String(b.bit)).join(" ");
    const fields = v.bits.map((b) => (b.idBit !== undefined ? `${b.field}${b.idBit}` : b.field)).join(" ");
    lines.push(`节点 ${v.node} (${v.format}, id=${v.id})  SOF=0(仅展示)`);
    lines.push(`  位:   ${bits}`);
    lines.push(`  字段: ${fields}`);
  }
  return lines.join("\n");
}

function printJson(x: unknown): void {
  console.log(JSON.stringify(x, null, 2));
}

export function runCli(argv: string[], store: Store): number {
  const [cmd, ...args] = argv;
  const opt = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
  const pos = args.filter((a) => !a.startsWith("--"));
  switch (cmd) {
    case "import": {
      const raw = JSON.parse(readFileSync(pos[0], "utf-8"));
      printJson(importScenario(store, raw, opt("key")));
      return 0;
    }
    case "versions":
      printJson(store.listVersions(pos[0]).map((r) => ({ version: r.version, rulesVersion: r.rules_version, createdAt: r.created_at })));
      return 0;
    case "vector":
      console.log(renderVectorTable(getVectors(store, pos[0], opt("version") ? Number(opt("version")) : undefined)));
      return 0;
    case "run": {
      const { body } = runArbitration(store, pos[0], opt("version") ? Number(opt("version")) : undefined, opt("key"));
      console.log(`runId=${body.runId} status=${body.status} winners=${body.winners.join(",")}`);
      if (body.note) console.log(`说明: ${body.note}`);
      if (body.conflictFields) printJson(body.conflictFields);
      console.log(renderSteps(body.steps));
      return 0;
    }
    case "show": {
      const run = getRun(store, Number(pos[0]));
      console.log(`runId=${run.runId} status=${run.status} winners=${run.winners.join(",")}`);
      console.log(renderSteps(run.steps));
      return 0;
    }
    case "why":
      printJson(eliminationReason(store, Number(pos[0]), pos[1]));
      return 0;
    case "diff":
      printJson(diffVersions(store, pos[0], Number(pos[1]), Number(pos[2])));
      return 0;
    case "export": {
      const fmt = pos[1] === "csv" ? "csv" : "json";
      const out = exportRun(store, Number(pos[0]), fmt as "json" | "csv");
      if (pos[2]) {
        writeFileSync(pos[2], out, "utf-8");
        console.log(`已导出到 ${pos[2]}`);
      } else {
        console.log(out);
      }
      return 0;
    }
    default:
      console.log(USAGE);
      return cmd ? 1 : 0;
  }
}

if (process.argv[1] && process.argv[1].endsWith("cli.js")) {
  if (process.argv[2] === "demo") {
    const { execFileSync } = await import("node:child_process");
    execFileSync(process.execPath, [process.argv[1], "import", "examples/mixed-frames.json"], { stdio: "inherit" });
    execFileSync(process.execPath, [process.argv[1], "run", "mixed-demo"], { stdio: "inherit" });
    process.exit(0);
  }
  const store = new Store(process.env.CAN_ARB_DB ?? defaultDbPath());
  try {
    process.exit(runCli(process.argv.slice(2), store));
  } catch (err) {
    console.error(JSON.stringify(errorBody(err), null, 2));
    process.exit(1);
  } finally {
    store.close();
  }
}
