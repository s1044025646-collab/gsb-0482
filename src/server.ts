import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { errorBody } from "./errors.js";
import { defaultDbPath, Store } from "./db.js";
import { diffVersions, eliminationReason, exportRun, getRun, getVectors, importScenario, runArbitration } from "./service.js";

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

export function createApp(store: Store) {
  return createServer(async (req, res) => {
    const send = (status: number, body: unknown, contentType = "application/json; charset=utf-8") => {
      const payload = typeof body === "string" ? body : JSON.stringify(body, null, 2);
      res.writeHead(status, { "Content-Type": contentType });
      res.end(payload);
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const idemKey = req.headers["idempotency-key"] as string | undefined;

      if (req.method === "GET" && url.pathname === "/health") {
        return send(200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/scenarios") {
        const { body, replayed } = importScenario(store, await readBody(req), idemKey);
        return send(replayed ? 200 : 201, { ...body, replayed });
      }
      if (req.method === "GET" && parts[0] === "scenarios" && parts.length === 3 && parts[2] === "versions") {
        const rows = store.listVersions(decodeURIComponent(parts[1]));
        return send(200, { name: parts[1], versions: rows.map((r) => ({ version: r.version, rulesVersion: r.rules_version, createdAt: r.created_at })) });
      }
      if (req.method === "GET" && parts[0] === "scenarios" && parts.length === 3 && parts[2] === "vector") {
        const v = url.searchParams.get("version");
        return send(200, getVectors(store, decodeURIComponent(parts[1]), v ? Number(v) : undefined));
      }
      if (req.method === "POST" && parts[0] === "scenarios" && parts.length === 3 && parts[2] === "arbitrate") {
        const v = url.searchParams.get("version");
        const { body, replayed } = runArbitration(store, decodeURIComponent(parts[1]), v ? Number(v) : undefined, idemKey);
        return send(200, { ...body, replayed });
      }
      if (req.method === "GET" && parts[0] === "scenarios" && parts.length === 3 && parts[2] === "diff") {
        const a = Number(url.searchParams.get("a"));
        const b = Number(url.searchParams.get("b"));
        if (!Number.isInteger(a) || !Number.isInteger(b)) throw new Error("diff 需要整数参数 a 和 b");
        return send(200, diffVersions(store, decodeURIComponent(parts[1]), a, b));
      }
      if (req.method === "GET" && parts[0] === "runs" && parts.length === 2) {
        return send(200, getRun(store, Number(parts[1])));
      }
      if (req.method === "GET" && parts[0] === "runs" && parts.length === 4 && parts[2] === "nodes") {
        return send(200, eliminationReason(store, Number(parts[1]), decodeURIComponent(parts[3])));
      }
      if (req.method === "GET" && parts[0] === "runs" && parts.length === 3 && parts[2] === "export") {
        const fmt = url.searchParams.get("format") === "csv" ? "csv" : "json";
        const out = exportRun(store, Number(parts[1]), fmt);
        return send(200, out, fmt === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8");
      }
      send(404, { error: { code: "E_NOT_FOUND", message: `未知路由 ${req.method} ${url.pathname}` } });
    } catch (err) {
      const body = errorBody(err);
      send(body.error.code === "E_INTERNAL" ? 500 : 400, body);
    }
  });
}

export function startServer(port?: number, dbPath?: string): Promise<{ port: number; close: () => void }> {
  const store = new Store(dbPath ?? process.env.CAN_ARB_DB ?? defaultDbPath());
  const app = createApp(store);
  const requested = port ?? (process.env.PORT ? Number(process.env.PORT) : 0); // 0 = 自动选择空闲端口
  return new Promise((resolve, reject) => {
    app.on("error", reject);
    app.listen(requested, "127.0.0.1", () => {
      const addr = app.address();
      const actual = typeof addr === "object" && addr ? addr.port : requested;
      resolve({ port: actual, close: () => { app.close(); store.close(); } });
    });
  });
}

if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  const portArg = process.argv.find((a) => a.startsWith("--port="));
  startServer(portArg ? Number(portArg.split("=")[1]) : undefined).then(({ port }) => {
    console.log(`CAN 仲裁服务已启动: http://127.0.0.1:${port}`);
  });
}
