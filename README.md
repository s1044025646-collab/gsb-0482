# Windows 本地 CAN 标准/扩展帧逐位仲裁后端

这是一个只包含 API 与 CLI 的离线经典 CAN 竞争仲裁分析服务。一批节点在同一时刻开始发送，程序逐位计算显性总线值、哪些节点在本位同时退出仲裁、最终优胜者或仲裁后同标识冲突。

不连接 CAN 硬件，不实现 CAN FD、完整 CRC、位填充、错误帧和自动重发。

## 环境与构建

要求 Windows 本地安装 Node.js 22.5 或更新版本。项目使用 Node 内置的 `node:sqlite`，不需要 Docker、WSL、Visual Studio 原生编译、付费服务或外部在线 API。

```powershell
npm install
npm run build
npm test
npm start
```

默认数据文件为项目内 `data/can-arbitration.sqlite`。默认不固定端口，服务启动时选择一个 `127.0.0.1` 空闲端口并打印到终端。也可以指定：

```powershell
npm start -- --port=3000 --data-dir=data
```

## 输入格式

`format` 只能是 `standard` 或 `extended`；`frameType` 只能是 `data` 或 `remote`。标识使用无符号十六进制整数：

可选 `scenarioKey` 用于声明版本族。不同 `requestId` 但相同 `scenarioKey` 的场景会形成版本线；修改标识重新导入时创建新版本，旧分析报告保持原样。若不传，系统使用当前完整场景内容生成内容键。

- 标准帧：`0x000` 到 `0x7FF`，超出十一位直接拒绝，不截断高位。
- 扩展帧：`0x00000000` 到 `0x1FFFFFFF`，超出二十九位直接拒绝。
- DLC：整数 `0` 到 `8`。
- 数据帧：`data` 为两位十六进制字节数组，长度必须等于 DLC。
- 远程帧：无载荷，`data` 必须为空或省略，但仍可声明请求长度 DLC。
- 节点名称必须非空且在同一场景中唯一；缺失字段会让整个场景拒绝。

## 比较向量

总线 0 为显性，1 为隐性。比较从共同的 SOF 开始记录，但 SOF 不造成分歧。

标准帧向量为：

```text
SOF + 11 位标识(ID28..ID18，最高位先发) + RTR + IDE(0)
```

数据帧 RTR=0，远程帧 RTR=1。

扩展帧向量为：

```text
SOF + 高 11 位标识(ID28..ID18) + SRR(1) + IDE(1) + 低 18 位标识(ID17..ID0) + RTR
```

每一位都保存字段名、字段内位置和原标识来源位。扩展 29 位标识的低 18 位不会被错当成标准基本标识。

每一步基于同一个步前存活集合计算：总线值为所有仍参与者发送位的逻辑与；发送 1 但读到 0 的节点在本位同时淘汰，后续位不再影响总线。只剩一个节点后立即停止，结果会明确列出未继续仲裁的比较位。

## 为什么不能只按完整数字 ID 排序

CAN 仲裁比较的是包含控制位的逐位发送向量，而不是把所有帧的完整数字 ID 放入数组取最小值。

以基本标识 `0x123` 为例：

- 标准数据帧在标识后的 RTR 位发送 0；
- 标准远程帧在同一位发送 1；
- 扩展帧在同一位发送 SRR=1。

所以标准数据帧在 RTR/SRR 位置同时击败另外两者。移除标准数据帧后，标准远程帧下一位发送 IDE=0，扩展帧发送 IDE=1，标准远程帧在 IDE 位获胜。

此外，两个节点可能拥有完全相同的仲裁向量，却在仲裁结束后的 DLC 或数据载荷阶段冲突；这种情况返回 `post_arbitration_conflict`，不能声称某节点在仲裁位失败，也不能任意挑选一个成功者。

## CLI

```powershell
# 导入并查看内置演示
npm run demo

# 导入文件
npm run cli -- import .\scenarios\demo.json

# 查看场景、比较向量和对齐零一列
npm run cli -- list
npm run cli -- vectors demo-0x123
npm run cli -- analyze demo-0x123

# 查询某节点退出原因
npm run cli -- reason demo-0x123 EXT_DATA

# 导出 JSON 或 CSV
npm run cli -- export demo-0x123 --format=json
npm run cli -- export demo-0x123 --format=csv --out=.\data\demo.csv

# 查看同内容场景版本线和旧报告
npm run cli -- versions demo-0x123
```

CLI 表格中的位编号包含 SOF：0 是 SOF，1 到 11 是标准/扩展共用高十一位，12 是标准 RTR 或扩展 SRR，13 是 IDE。

## HTTP API

以下把 `$u` 替换为启动时打印的地址。

```powershell
# 导入，请求号 requestId 幂等
Invoke-RestMethod -Method Post "$u/api/v1/scenarios" `
  -ContentType "application/json" `
  -InFile ".\scenarios\demo.json"

# 比较向量和独立字典序核对
Invoke-RestMethod "$u/api/v1/scenarios/demo-0x123/vectors"

# 运行或重复获取分析
Invoke-RestMethod -Method Post "$u/api/v1/scenarios/demo-0x123/analysis"
Invoke-RestMethod "$u/api/v1/scenarios/demo-0x123/analysis"

# 节点淘汰原因
Invoke-RestMethod "$u/api/v1/scenarios/demo-0x123/nodes/EXT_DATA"

# 版本对照与导出
Invoke-RestMethod "$u/api/v1/scenarios/demo-0x123/versions"
Invoke-WebRequest "$u/api/v1/scenarios/demo-0x123/analysis/export?format=csv"
```

主要接口：

- `GET /api/v1/health`
- `POST /api/v1/scenarios`
- `GET /api/v1/scenarios`
- `GET /api/v1/scenarios/:idOrRequestId`
- `GET /api/v1/scenarios/:idOrRequestId/vectors`
- `POST /api/v1/scenarios/:idOrRequestId/analysis`
- `GET /api/v1/scenarios/:idOrRequestId/analysis`
- `GET /api/v1/scenarios/:idOrRequestId/analysis/export?format=json|csv`
- `GET /api/v1/scenarios/:idOrRequestId/nodes/:nodeName`
- `GET /api/v1/scenarios/:idOrRequestId/versions`

## 结果类型

- `winner`：唯一节点通过仲裁，后续比较位未继续模拟。
- `co_send`：多个节点格式、完整 29 位语义标识、帧类型、DLC、数据完全一致，可共同发送同一帧并保留所有身份。
- `post_arbitration_conflict`：仲裁无法区分，但 DLC 或载荷不同；结果只定位这些后续字段差异，不推导线缆错误位精确时刻。

## 持久化与错误码

SQLite 保存完整输入、规范化场景、规则版本、每一步参与者、各节点发送位、总线值、本位淘汰者、存活集合和最终结果。报告发布使用数据库事务；分析失败不会写入半份结果。相同 `requestId` 重复提交相同内容返回原记录；相同请求号提交不同内容返回 `409 IDEMPOTENCY_CONFLICT`。

错误码包括：

- `VALIDATION_ERROR`：输入结构、范围、DLC 或载荷不合法。
- `NOT_FOUND`：场景、报告或节点不存在。
- `IDEMPOTENCY_CONFLICT`：相同请求号对应不同内容。
- `PAYLOAD_TOO_LARGE`：请求体超过 1 MiB。
- `INTERNAL_ERROR`：未预期服务器错误。

当前限制：最多 64 个节点、DLC 最大 8、HTTP JSON 请求体 1 MiB；本项目只做教学和离线分析，不提供时序校准、波形图或真实硬件行为。
