# CAN 逐位仲裁与同标识冲突核验后端

离线经典 CAN 标识仲裁分析服务：一批节点同一时刻开始发送，逐位计算谁在第几位退出仲裁、谁最终胜出，以及并列存活节点能否共同发送同一帧。纯后端，提供 HTTP API 与 CLI，TypeScript + Node.js + SQLite（`node:sqlite`，零原生依赖），Windows 本地直接运行。

## 范围

- 支持：11 位标准帧、29 位扩展帧、数据帧与远程帧、含 IDE 的比较向量、逐位显性优先仲裁、同标识共同发送与冲突核验、场景版本管理、幂等导入、JSON/CSV 导出。
- 不支持（明确不实现）：CAN FD、完整 CRC、位填充、错误帧、自动重发、硬件连接。

## 快速开始

```powershell
npm install        # 仅安装 typescript 与 @types/node（开发依赖）
npm run build      # 编译到 dist/
npm test           # 编译并运行全部测试（node:test）
npm start          # 启动 API 服务，默认自动选择空闲端口
npm start -- --port=8080   # 指定端口（也可用环境变量 PORT）
node dist/cli.js run mixed-demo   # CLI 示例
npm run demo       # 导入并运行内置演示场景
```

数据目录默认为项目内 `./data/can-arb.db`，可用环境变量 `CAN_ARB_DB` 覆盖。重启后所有历史记录仍可读取。

## 场景格式

```json
{
  "name": "mixed-demo",
  "nodes": [
    { "name": "std-data",   "format": "standard", "id": "0x123",      "frameType": "data",   "dlc": 2, "data": "AA55" },
    { "name": "std-remote", "format": "standard", "id": "0x123",      "frameType": "remote", "dlc": 2 },
    { "name": "ext-data",   "format": "extended", "id": "0x048C0000", "frameType": "data",   "dlc": 1, "data": "01" }
  ]
}
```

校验规则（任一节点违规则整个场景被拒绝）：

- `name` 场景内唯一；`format` 为 `standard` 或 `extended`；`frameType` 为 `data` 或 `remote`。
- `id` 为十六进制字符串，按无符号整数校验范围：标准帧不超过 0x7FF，扩展帧不超过 0x1FFFFFFF，超出位数的高位直接报错，绝不截断。
- `dlc` 为 0..8 整数；数据帧字节数必须等于 DLC；远程帧无载荷但可声明请求长度 DLC。

## 比较向量与仲裁规则

起始位 SOF 各节点相同，仅展示不参与比较。比较向量（高位先发）：

- 标准帧：`ID10..0, RTR, IDE=0`
- 扩展帧：`ID28..18, SRR=1, IDE=1, ID17..0, RTR`

每一位都带字段名、字段内位置与原标识位号（`idBit`），扩展帧低 18 位不会被错当基本标识。总线 0 为显性：每步在仍参与节点间取逻辑与，发 1 读到 0 的节点基于同一个步前集合同时淘汰，之后不再影响总线。每步记录参与者、各自发送位、总线值、退出节点与存活集合。只剩一个节点时直接报告优胜者，后续位标注为未继续仲裁。

仲裁结束可能剩多个节点：

- 格式、完整标识、帧类型、DLC、数据全部一致，标记 `co_transmit`，共同发送同一帧，保留全部节点身份。
- 仲裁位相同但 DLC 或载荷不同，返回 `post_arbitration_conflict`，只定位差异字段（`dlc` 或 `data`），不指定任何节点成功。

## 为什么不能只按完整数字 ID 排序

1. 标准帧与扩展帧不可直接比数值：扩展帧先发送高 11 位，随后是 SRR=1、IDE=1；标准帧在相同位置发 RTR、IDE=0。例如扩展帧 `0x048C0000` 数值远大于标准帧 `0x123`，但它们高 11 位相同，标准数据帧会在第 12 位（RTR/SRR）以显性 0 胜出，按数值排序会得出完全相反的结论。
2. 帧类型参与仲裁：同 ID 的标准数据帧（RTR=0）优先于远程帧（RTR=1），数值 ID 却完全相同。
3. 仲裁结果可能不是唯一节点：相同向量可能共同发送或冲突，数值排序无法表达。

因此本实现逐位模拟，并用比较向量字典序排序作为独立核对手段（见测试）。

## HTTP API

- `POST /scenarios`：导入场景，内容变化自动创建新版本，支持 `Idempotency-Key` 头幂等重放。
- `GET /scenarios/:name/versions`：列出全部版本。
- `GET /scenarios/:name/vector?version=N`：查看各帧比较向量（含字段与来源位标注）。
- `POST /scenarios/:name/arbitrate?version=N`：运行逐位仲裁（支持幂等键），返回逐步记录。
- `GET /scenarios/:name/diff?a=1&b=2`：对照两个版本差异。
- `GET /runs/:id`：查询运行结果与每步真实记录。
- `GET /runs/:id/nodes/:node`：查询某节点淘汰原因（位号、字段、发送位、总线位）。
- `GET /runs/:id/export?format=json` 或 `format=csv`：导出（步数上限 1000）。
- `GET /health`：健康检查。

错误统一为 `{ "error": { "code", "message", "details?" } }`。错误码：`E_MISSING_FIELD`、`E_DUPLICATE_NODE`、`E_BAD_FORMAT`、`E_BAD_FRAME_TYPE`、`E_BAD_HEX`、`E_ID_RANGE`、`E_DLC_RANGE`、`E_DATA_LENGTH`、`E_REMOTE_PAYLOAD`、`E_TOO_MANY_NODES`（超过 64 节点）、`E_EMPTY_SCENARIO`、`E_NOT_FOUND`、`E_EXPORT_LIMIT`、`E_BAD_REQUEST`、`E_INTERNAL`。

## CLI

```powershell
node dist/cli.js import examples/mixed-frames.json --key=demo1
node dist/cli.js versions mixed-demo
node dist/cli.js vector mixed-demo
node dist/cli.js run mixed-demo            # 对齐 0/1 列展示，* 标注决定胜负的位置
node dist/cli.js why 1 std-remote          # 淘汰原因
node dist/cli.js diff mixed-demo 1 2
node dist/cli.js export 1 csv out.csv
```

## 持久化与一致性

SQLite 保存完整场景输入、规则版本（`can-arb-v1`）、每步存活集合与最终结果。同名场景内容变化生成新版本，旧版本与旧报告不受影响；运行结果在单事务内写入，分析失败不会留下半份记录；幂等键保证重复请求返回首个响应。

## 测试

`npm test` 覆盖：0x123 三帧混合（RTR/SRR 与 IDE 决胜）、同标识同载荷与异载荷、标准 ID 0 与 0x7FF、扩展最大值、低 18 位差异、单节点、节点顺序置换、非法 DLC 等校验、字典序核对逐位第一处分歧、API 全流程与幂等重放。

## 限制

- 仅经典 CAN 标识段仲裁；不模拟数据段总线电平、位填充、CRC、错误处理与时序。
- `node:sqlite` 在 Node 25 仍带 Experimental 警告，功能稳定可用；如需消除警告可换 `better-sqlite3`。
- 参与节点上限 64，导出步数上限 1000。
