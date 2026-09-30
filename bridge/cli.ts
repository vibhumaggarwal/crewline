import { WebSocket } from "ws";
import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { resolve, join } from "node:path";
import { hostname } from "node:os";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import type { Agent, Project, Task } from "../shared/types";
import {
  context,
  exec,
  git,
  memoryDir,
  prepareAgent,
  readMemory,
  safePath,
  validateProject,
} from "./workspace";
import { ClaudeCodeRuntime } from "./runtime";
const data = resolve(process.env.CREWLINE_DATA || ".crewline");
const base =
  process.env.CREWLINE_URL || `http://127.0.0.1:${process.env.PORT || 4317}`;
const url = new URL(base);
if (
  !["127.0.0.1", "localhost"].includes(url.hostname) ||
  url.protocol !== "http:"
)
  throw new Error("V0 supports a loopback coordinator only");
let token: string;
try {
  ({ token } = JSON.parse(
    await fs.readFile(join(data, "credentials.json"), "utf8"),
  ));
} catch {
  console.error("Start the coordinator with npm run dev before connecting.");
  process.exit(1);
}
if (process.argv[2] === "login") {
  const link = `${base}/#token=${token}`;
  console.log(`Open this private local login link:\n${link}`);
  if (process.platform === "darwin") spawn("open", [link], { stdio: "ignore" });
  process.exit(0);
}
if (process.argv[2] !== "connect") {
  console.log("Usage: npm run login | npm run connect");
  process.exit(1);
}
type Run = {
  task: Task;
  agent: Agent;
  project: Project;
  token: string;
  paused: boolean;
  result?: any;
  started: number;
  output: string;
  baseCommit?: string;
  command?: ReturnType<typeof spawn>;
  toolBusy?: boolean;
};
const runtime = new ClaudeCodeRuntime();
const runs = new Map<string, Run>();
const agents = new Map<string, Agent>();
const projects = new Map<string, Project>();
const approvals = new Map<
  string,
  { taskId: string; resolve: (v: boolean) => void }
>();
let socket: WebSocket;
let endpoint = "";
let stopping = false;
const send = (m: unknown) => {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(m));
};
const event = (r: Run, kind: string, text: string, raw?: string) =>
  send({
    type: "event",
    event: {
      taskId: r.task.id,
      agentId: r.agent.id,
      projectId: r.project.id,
      kind,
      text,
      raw,
    },
  });
async function approve(r: Run, title: string, detail: string) {
  const id = randomUUID();
  send({
    type: "approval",
    approval: {
      id,
      taskId: r.task.id,
      agentId: r.agent.id,
      title,
      detail,
      status: "pending",
      created_at: new Date().toISOString(),
    },
  });
  event(r, "approval", title);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => finish(false), 5 * 60 * 1000);
    const finish = (v: boolean) => {
      clearTimeout(timer);
      approvals.delete(id);
      send({ type: "approvalDone", id });
      resolve(v);
    };
    approvals.set(id, { taskId: r.task.id, resolve: finish });
  });
}
async function runCommand(r: Run, command: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const p = spawn(command, args, {
      cwd: r.agent.workspace,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    r.command = p;
    let output = "";
    const collect = (b: Buffer) => {
      output = (output + b.toString()).slice(-100000);
    };
    p.stdout.on("data", collect);
    p.stderr.on("data", collect);
    const timer = setTimeout(() => {
      killCommand(r);
    }, 120000);
    p.once("error", (e) => {
      clearTimeout(timer);
      r.command = undefined;
      reject(e);
    });
    p.once("close", (code) => {
      clearTimeout(timer);
      r.command = undefined;
      if (code !== 0) reject(new Error(`Command exited ${code}:\n${output}`));
      else resolve(output);
    });
  });
}
function killCommand(r: Run) {
  const p = r.command;
  if (p?.pid) {
    try {
      if (process.platform !== "win32") process.kill(-p.pid, "SIGTERM");
      else p.kill("SIGTERM");
    } catch {}
  }
}
async function tool(r: Run, name: string, args: any) {
  if (r.paused) throw new Error("Task paused");
  const a = r.agent,
    p = r.project;
  if (name === "list_files") {
    if (!a.permissions.read) throw new Error("Read permission disabled");
    const path = await safePath(a.workspace, args.path || ".");
    return (await fs.readdir(path, { withFileTypes: true }))
      .filter(
        (e) => ![".git", ".agents", ".claude", "node_modules"].includes(e.name),
      )
      .slice(0, 1000)
      .map((e) => ({ name: e.name, directory: e.isDirectory() }));
  }
  if (name === "read_file") {
    if (!a.permissions.read) throw new Error("Read permission disabled");
    const path = await safePath(a.workspace, args.path);
    if ((await fs.stat(path)).size > 500000)
      throw new Error("File exceeds 500 KB");
    event(r, "read", `Reading ${args.path}`);
    return fs.readFile(path, "utf8");
  }
  if (name === "write_file") {
    if (!a.permissions.write) throw new Error("Write permission disabled");
    const path = await safePath(a.workspace, args.path, true);
    if (typeof args.content !== "string" || args.content.length > 500000)
      throw new Error("Invalid file content");
    await fs.mkdir(resolve(path, ".."), { recursive: true });
    await safePath(a.workspace, args.path, true);
    await fs.writeFile(path, args.content);
    event(r, "write", `Updated ${args.path}`);
    return { saved: args.path };
  }
  if (name === "git_inspect") {
    if (!a.permissions.git) throw new Error("Git permission disabled");
    const options: Record<string, string[]> = {
      status: ["status", "--short"],
      diff: ["diff", "HEAD", "--stat"],
      log: ["log", "-8", "--oneline"],
    };
    if (!options[args.operation]) throw new Error("Unknown operation");
    return git(a.workspace, options[args.operation]);
  }
  if (name === "save_memory") {
    if (
      typeof args.memory !== "string" ||
      typeof args.progress !== "string" ||
      args.memory.length > 50000 ||
      args.progress.length > 50000
    )
      throw new Error("Invalid memory");
    await fs.writeFile(join(memoryDir(a, p), "memory.md"), args.memory);
    await fs.writeFile(join(memoryDir(a, p), "progress.md"), args.progress);
    send({ type: "memory", id: a.id, ...(await readMemory(a, p)) });
    event(r, "memory", "Saved persistent memory");
    return { saved: true };
  }
  if (name === "list_workers")
    return [...agents.values()]
      .filter((v) => v.projectId === p.id)
      .map((v) => ({ id: v.id, name: v.name, role: v.role }));
  if (name === "handoff") {
    const recipient = agents.get(args.recipient);
    if (!recipient || recipient.projectId !== p.id || recipient.id === a.id)
      throw new Error("Select another worker from this project");
    send({
      type: "handoff",
      taskId: r.task.id,
      ...args,
      context: `${args.context || ""}\nSource branch: ${a.branch}\nCurrent commit: ${await git(a.workspace, ["rev-parse", "HEAD"])}`,
    });
    return { submitted: true };
  }
  if (name === "integrate_commit") {
    if (!a.permissions.git || !a.permissions.write)
      throw new Error("Write and Git permissions required");
    if (typeof args.commit !== "string" || !/^[a-f0-9]{40}$/.test(args.commit))
      throw new Error("Use a full 40-character commit SHA from the handoff");
    const branches = [...agents.values()]
      .filter((x) => x.projectId === p.id && x.id !== a.id)
      .map((x) => x.branch);
    let valid = false;
    for (const branch of branches) {
      try {
        await git(a.workspace, [
          "merge-base",
          "--is-ancestor",
          args.commit,
          branch,
        ]);
        valid = true;
        break;
      } catch {}
    }
    if (!valid)
      throw new Error("Commit must belong to another worker in this project");
    if (await git(a.workspace, ["status", "--porcelain"]))
      throw new Error(
        "Commit or resolve local changes before integrating a handoff",
      );
    const summary = await git(a.workspace, [
      "show",
      "--stat",
      "--oneline",
      args.commit,
    ]);
    if (
      !(await approve(
        r,
        `${a.name} wants to integrate a handoff commit`,
        `${a.branch}\nCommit: ${args.commit}\n${summary}`,
      ))
    )
      throw new Error("Integration rejected or approval expired");
    if (r.paused) throw new Error("Task paused");
    if (await git(a.workspace, ["status", "--porcelain"]))
      throw new Error("Worktree changed after approval");
    try {
      await git(a.workspace, [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "cherry-pick",
        args.commit,
      ]);
    } catch (e) {
      await git(a.workspace, ["cherry-pick", "--abort"]).catch(() => {});
      throw new Error(
        `Could not apply the handoff commit; integration was aborted. ${String(e)}`,
      );
    }
    event(r, "success", `Integrated handoff commit ${args.commit.slice(0, 7)}`);
    return { commit: await git(a.workspace, ["rev-parse", "HEAD"]) };
  }
  if (name === "run_tests") {
    if (!a.permissions.tests) throw new Error("Test permission disabled");
    const pkg = JSON.parse(
      await fs.readFile(await safePath(a.workspace, "package.json"), "utf8"),
    );
    if (!pkg.scripts?.test) throw new Error("No npm test script found");
    const detail = `Workspace: ${a.workspace}\nCommand: npm test\nTest script: ${pkg.scripts.test}\nPretest: ${pkg.scripts.pretest || "(none)"}\nPosttest: ${pkg.scripts.posttest || "(none)"}\nRepository scripts execute with your OS user privileges. Review the scripts before approving.`;
    if (!(await approve(r, `${a.name} wants to run npm test`, detail)))
      throw new Error("Test execution rejected or approval expired");
    if (r.paused) throw new Error("Task paused");
    const current = JSON.parse(
      await fs.readFile(await safePath(a.workspace, "package.json"), "utf8"),
    );
    if (JSON.stringify(current.scripts) !== JSON.stringify(pkg.scripts))
      throw new Error("Test scripts changed after approval; request again");
    event(r, "test", "Running repository tests");
    const output = await runCommand(r, "npm", ["test"]);
    event(r, "success", "Test command passed");
    return output;
  }
  if (name === "commit") {
    if (!a.permissions.git || !a.permissions.write)
      throw new Error("Write and Git permissions required");
    if (typeof args.message !== "string" || !args.message.trim())
      throw new Error("Commit message required");
    const diff = await git(a.workspace, ["diff", "HEAD", "--stat"]);
    const status = await git(a.workspace, ["status", "--short"]);
    if (
      !(await approve(
        r,
        `${a.name} wants to create a commit`,
        `${a.branch}\n${args.message}\n\n${diff}\n${status}`,
      ))
    )
      throw new Error("Commit rejected or approval expired");
    if (r.paused) throw new Error("Task paused");
    if ((await git(a.workspace, ["branch", "--show-current"])) !== a.branch)
      throw new Error("Worker branch changed");
    await git(a.workspace, [
      "-c",
      "core.hooksPath=/dev/null",
      "add",
      "--all",
      "--",
      ".",
      ":(exclude).agents",
      ":(exclude).claude",
    ]);
    await git(a.workspace, [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      args.message,
    ]);
    const commit = await git(a.workspace, ["rev-parse", "HEAD"]);
    event(r, "success", `Created commit ${commit.slice(0, 7)}`);
    return { commit };
  }
  throw new Error("Unknown tool");
}
const http = createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/tool") {
    res.writeHead(404).end();
    return;
  }
  const bearer = req.headers.authorization?.replace(/^Bearer /, "");
  const r = [...runs.values()].find((r) => r.token === bearer);
  if (!r) {
    res.writeHead(401).end();
    return;
  }
  let body = "";
  try {
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 600000) throw new Error("Request too large");
    }
    const { tool: name, args } = JSON.parse(body);
    if (r.toolBusy)
      throw new Error("Another worker tool is still running; wait and retry");
    r.toolBusy = true;
    try {
      const result = await tool(r, name, args);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(result));
    } finally {
      r.toolBusy = false;
    }
  } catch (e) {
    res
      .writeHead(400, { "Content-Type": "application/json" })
      .end(JSON.stringify({ error: (e as Error).message }));
  }
});
await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
endpoint = `http://127.0.0.1:${(http.address() as any).port}`;
async function start(m: { task: Task; agent: Agent; project: Project }) {
  if ([...runs.values()].some((r) => r.agent.id === m.agent.id))
    throw new Error("Worker already running");
  const r: Run = {
    ...m,
    token: randomBytes(32).toString("hex"),
    paused: false,
    started: Date.now(),
    output: "",
  };
  runs.set(r.task.id, r);
  try {
    r.baseCommit = await git(r.agent.workspace, ["rev-parse", "HEAD"]);
    const prompt = await context(r.agent, r.project, r.task);
    await fs.writeFile(
      join(memoryDir(r.agent, r.project), "progress.md"),
      `# Current task\n${r.task.title}\n${r.task.description}\n`,
    );
    event(r, "start", "Starting Claude Code session");
    runtime.startAgent(
      {
        workspace: r.agent.workspace,
        prompt,
        taskId: r.task.id,
        endpoint,
        token: r.token,
      },
      (e) => {
        if (e.type === "system" && e.session_id)
          send({
            type: "taskUpdate",
            id: r.task.id,
            patch: { sessionId: e.session_id },
          });
        if (e.type === "stream_event" && e.event?.delta?.text) {
          r.output = (r.output + e.event.delta.text).slice(-100000);
          send({
            type: "taskUpdate",
            id: r.task.id,
            patch: { result: r.output },
          });
        }
        if (e.type === "assistant") {
          for (const b of e.message?.content || [])
            if (b.type === "text")
              event(r, "output", b.text.slice(0, 12000), JSON.stringify(e));
        }
        if (e.type === "log") event(r, "log", e.text, e.text);
        if (e.type === "result") r.result = e;
      },
      (code) => {
        void finish(r, code).catch((e) => {
          send({
            type: "taskUpdate",
            id: r.task.id,
            patch: {
              status: "FAILED",
              result: `Unable to persist run: ${e.message}`,
            },
          });
          runs.delete(r.task.id);
        });
      },
    );
  } catch (e) {
    runs.delete(r.task.id);
    throw e;
  }
}
async function finish(r: Run, code: number | null) {
  for (const approval of approvals.values())
    if (approval.taskId === r.task.id) approval.resolve(false);
  killCommand(r);
  const state = r.paused
    ? "WAITING"
    : code === 0 && r.result && !r.result.is_error
      ? "COMPLETED"
      : "FAILED";
  const result =
    r.result?.result ||
    r.output ||
    (r.paused
      ? "Paused. Resume from saved memory and Git state."
      : `Claude exited ${code} without a final result. Check authentication and logs.`);
  const changed = await git(r.agent.workspace, [
    "diff",
    "--name-status",
    r.baseCommit || "HEAD",
    "HEAD",
  ]).catch(() => "");
  const files = [
    ...new Set(
      (
        changed +
        "\n" +
        (await git(r.agent.workspace, ["status", "--short"]).catch(() => ""))
      )
        .split("\n")
        .filter(Boolean),
    ),
  ];
  const git_commit = await git(r.agent.workspace, ["rev-parse", "HEAD"]).catch(
    () => undefined,
  );
  const patch = {
    status: state,
    result,
    files,
    git_commit,
    inputTokens: r.result?.usage?.input_tokens || 0,
    outputTokens: r.result?.usage?.output_tokens || 0,
    durationMs: Date.now() - r.started,
  };
  await fs.writeFile(
    join(memoryDir(r.agent, r.project), "tasks", `${r.task.id}.json`),
    JSON.stringify({ ...r.task, ...patch }, null, 2),
  );
  await fs.appendFile(
    join(memoryDir(r.agent, r.project), "progress.md"),
    `\n\n## ${state}\n${result}\n`,
  );
  send({
    type: "memory",
    id: r.agent.id,
    ...(await readMemory(r.agent, r.project)),
  });
  runs.delete(r.task.id);
  send({ type: "taskUpdate", id: r.task.id, patch });
  event(
    r,
    state === "COMPLETED" ? "success" : state === "WAITING" ? "pause" : "error",
    state === "COMPLETED"
      ? "Task completed"
      : state === "WAITING"
        ? "Worker paused"
        : String(result).slice(0, 2000),
  );
}
async function handle(m: any) {
  if (m.type === "project") {
    try {
      const path = await validateProject(m.project);
      projects.set(m.project.id, { ...m.project, path });
      send({ type: "projectReady", id: m.project.id, path });
    } catch (e) {
      send({
        type: "projectReady",
        id: m.project.id,
        path: m.project.path,
        error: (e as Error).message,
      });
    }
  }
  if (m.type === "agent") {
    try {
      projects.set(m.project.id, m.project);
      const workspace = await prepareAgent(m.agent, m.project, data);
      agents.set(m.agent.id, { ...m.agent, workspace });
      send({ type: "agentReady", id: m.agent.id, workspace });
      send({
        type: "memory",
        id: m.agent.id,
        ...(await readMemory(m.agent, m.project)),
      });
    } catch (e) {
      send({ type: "agentReady", id: m.agent.id, error: (e as Error).message });
    }
  }
  if (m.type === "saveMemory") {
    const p = projects.get(m.agent.projectId);
    if (!p) throw new Error("Project unavailable");
    await fs.writeFile(join(memoryDir(m.agent, p), "memory.md"), m.memory);
    send({ type: "memory", id: m.agent.id, ...(await readMemory(m.agent, p)) });
  }
  if (m.type === "run") {
    agents.set(m.agent.id, m.agent);
    projects.set(m.project.id, m.project);
    await start(m).catch((e) =>
      send({
        type: "taskUpdate",
        id: m.task.id,
        patch: { status: "FAILED", result: e.message },
      }),
    );
  }
  if (m.type === "pause") {
    const r = runs.get(m.taskId);
    if (r) {
      r.paused = true;
      killCommand(r);
      for (const a of approvals.values())
        if (a.taskId === m.taskId) a.resolve(false);
      runtime.stopAgent(m.taskId);
    }
  }
  if (m.type === "decision") approvals.get(m.id)?.resolve(m.approved === true);
}
async function connect() {
  if (runs.size) {
    setTimeout(() => void connect().catch(retry), 1000);
    return;
  }
  const state = (await fetch(`${base}/api/state`, {
    headers: { Authorization: `Bearer ${token}` },
  }).then((r) => r.json())) as any;
  for (const p of state.projects || []) projects.set(p.id, p);
  for (const a of state.agents || []) agents.set(a.id, a);
  const version = await exec(process.env.CREWLINE_CLAUDE || "claude", [
    "--version",
  ])
    .then((r) => r.stdout.trim())
    .catch(() => undefined);
  socket = new WebSocket(`${base.replace(/^http/, "ws")}/bridge`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  socket.on("open", () => {
    console.log(
      `Local bridge connected. Claude Code: ${version || "not found"}`,
    );
    send({ type: "hello", claude: !!version, version, hostname: hostname() });
  });
  socket.on("message", (buf) => {
    try {
      void handle(JSON.parse(buf.toString())).catch((e) =>
        send({ type: "event", event: { kind: "error", text: e.message } }),
      );
    } catch {}
  });
  socket.on("error", (e) => console.error(e.message));
  socket.on("close", () => {
    for (const r of runs.values()) {
      r.paused = true;
      killCommand(r);
      runtime.stopAgent(r.task.id);
    }
    for (const a of approvals.values()) a.resolve(false);
    if (!stopping) setTimeout(() => void connect().catch(retry), 3000);
  });
}
function retry(e: unknown) {
  console.error(`Connection unavailable: ${String(e)}. Retrying…`);
  if (!stopping) setTimeout(() => void connect().catch(retry), 3000);
}
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    stopping = true;
    for (const r of runs.values()) {
      r.paused = true;
      killCommand(r);
      runtime.stopAgent(r.task.id);
    }
    socket?.close();
    http.close();
    setTimeout(() => process.exit(0), 9000).unref();
  });
await connect().catch(retry);
