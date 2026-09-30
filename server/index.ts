import express from "express";
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { resolve } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { Store } from "./store";
import { Coordinator } from "./coordinator";
const data = resolve(process.env.CREWLINE_DATA || ".crewline");
mkdirSync(data, { recursive: true, mode: 0o700 });
chmodSync(data, 0o700);
const secretFile = resolve(data, "credentials.json");
if (!existsSync(secretFile))
  writeFileSync(
    secretFile,
    JSON.stringify({ token: randomBytes(32).toString("hex") }),
    { mode: 0o600 },
  );
const { token } = JSON.parse(readFileSync(secretFile, "utf8"));
const valid = (value: unknown) =>
  typeof value === "string" &&
  value.length === token.length &&
  timingSafeEqual(Buffer.from(value), Buffer.from(token));
const port = Number(process.env.PORT || 4317);
const app = express();
const server = createServer(app);
const c = new Coordinator(new Store(resolve(data, "crewline.sqlite")));
app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));
app.use((req, res, next) => {
  const host = req.headers.host?.split(":")[0];
  if (!["localhost", "127.0.0.1"].includes(host || ""))
    return res.status(403).json({ error: "Invalid local host" });
  const origin = req.headers.origin;
  if (
    origin &&
    !new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]).has(
      origin,
    )
  )
    return res.status(403).json({ error: "Cross-origin access denied" });
  next();
});
app.post("/api/session", (req, res) => {
  if (!valid(req.body.token))
    return res
      .status(401)
      .json({ error: "Invalid login link. Run npm run login." });
  res.cookie("crewline", token, {
    httpOnly: true,
    sameSite: "strict",
    path: "/",
  });
  res.json({ ok: true });
});
const authorized = (req: any) =>
  valid(req.headers.authorization?.replace(/^Bearer /, "")) ||
  valid(
    req.headers.cookie
      ?.split("; ")
      .find((x: string) => x.startsWith("crewline="))
      ?.slice(9),
  );
app.use("/api", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  if (!authorized(req))
    return res
      .status(401)
      .json({ error: "Run npm run login to open your workspace." });
  next();
});
const clients = new Set<express.Response>();
c.broadcast = () => {
  const payload = `data: ${JSON.stringify(c.snapshot())}\n\n`;
  for (const res of clients) res.write(payload);
};
app.get("/api/state", (_req, res) => res.json(c.snapshot()));
app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  clients.add(res);
  res.write(`data: ${JSON.stringify(c.snapshot())}\n\n`);
  const timer = setInterval(() => res.write(": heartbeat\n\n"), 15000);
  req.on("close", () => {
    clients.delete(res);
    clearInterval(timer);
  });
});
app.post("/api/projects", (req, res) => res.json(c.createProject(req.body)));
app.post("/api/agents", (req, res) => res.json(c.createAgent(req.body)));
app.post("/api/tasks", (req, res) => res.json(c.createTask(req.body)));
app.post("/api/tasks/:id/:action", (req, res) => {
  c.control(req.params.id, req.params.action);
  res.json({ ok: true });
});
app.post("/api/approvals/:id", (req, res) => {
  if (typeof req.body.approved !== "boolean")
    throw new Error("Decision required");
  c.decide(req.params.id, req.body.approved);
  res.json({ ok: true });
});
app.post("/api/agents/:id/memory", (req, res) => {
  if (!c.bridge.connected) throw new Error("Connect the bridge to edit memory");
  if (typeof req.body.memory !== "string" || req.body.memory.length > 50000)
    throw new Error("Memory must be under 50,000 characters");
  const a = c.store.get<any>("agent", req.params.id);
  if (
    c.store
      .all<any>("task")
      .some(
        (t) =>
          t.agent === a.id && ["RUNNING", "NEEDS_APPROVAL"].includes(t.status),
      )
  )
    throw new Error("Pause the worker before editing its memory");
  c.send({ type: "saveMemory", agent: a, memory: req.body.memory });
  res.json({ ok: true });
});
app.use("/api", (err: any, _req: any, res: any, _next: any) =>
  res.status(400).json({ error: err.message || "Request failed" }),
);
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 2 * 1024 * 1024,
});
let bridge: WebSocket | undefined;
server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/bridge") return;
  if (
    !valid(req.headers.authorization?.replace(/^Bearer /, "")) ||
    bridge?.readyState === WebSocket.OPEN
  ) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
});
wss.on("connection", (ws) => {
  bridge = ws;
  let alive = true;
  ws.on("pong", () => (alive = true));
  const heartbeat = setInterval(() => {
    if (!alive) return ws.terminate();
    alive = false;
    ws.ping();
  }, 15000);
  c.send = (m) => {
    if (ws.readyState !== WebSocket.OPEN)
      throw new Error("Bridge disconnected");
    ws.send(JSON.stringify(m));
  };
  ws.on("message", (data) => {
    try {
      c.receive(JSON.parse(data.toString()));
    } catch (e) {
      c.event({ kind: "error", text: (e as Error).message });
    }
  });
  ws.on("close", () => {
    clearInterval(heartbeat);
    if (bridge === ws) {
      bridge = undefined;
      c.disconnect();
    }
  });
});
if (process.env.NODE_ENV === "production")
  app.use(express.static(resolve("dist")));
else {
  const { createServer: createVite } = await import("vite");
  const vite = await createVite({
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
}
if (process.env.NODE_ENV === "production")
  app.get("/{*path}", (_req, res) => res.sendFile(resolve("dist/index.html")));
server.listen(port, "127.0.0.1", () =>
  console.log(
    `Crewline ready at http://127.0.0.1:${port}. Run npm run login, then npm run connect.`,
  ),
);
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    bridge?.close();
    server.close();
    process.exit(0);
  });
