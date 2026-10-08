import { Server } from "node:http"
import { createApp } from "./api"
import { Store } from "./db"

function findFreePort(preferred?: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = require("node:net").createServer()
    probe.on("error", reject)
    probe.listen(preferred ?? 0, "127.0.0.1", () => {
      const address = probe.address()
      const port = typeof address === "object" && address ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

async function main() {
  const args = new Map(process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, "").split("=")
    return [key, value ?? "true"]
  }))
  const dataDir = args.get("data-dir") ?? "data"
  const store = new Store(`${dataDir}/can-arbitration.sqlite`)
  const app: Server = createApp(store)
  const requested = args.has("port") ? Number(args.get("port")) : undefined
  if (requested !== undefined && (!Number.isInteger(requested) || requested < 1 || requested > 65535)) {
    throw new Error("端口必须是 1 到 65535 的整数")
  }
  const port = await findFreePort(requested)
  app.listen(port, "127.0.0.1", () => {
    console.log(`CAN 仲裁服务已启动: http://127.0.0.1:${port}`)
    console.log(`SQLite 数据目录: ${dataDir}`)
  })
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
