import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
export interface RuntimeRequest {
  workspace: string;
  prompt: string;
  taskId: string;
  endpoint: string;
  token: string;
}
export interface AgentRuntime {
  startAgent(
    request: RuntimeRequest,
    onEvent: (event: any) => void,
    onExit: (code: number | null) => void,
  ): void;
  sendTask(
    request: RuntimeRequest,
    onEvent: (event: any) => void,
    onExit: (code: number | null) => void,
  ): void;
  getStatus(taskId: string): "running" | "stopped";
  stopAgent(taskId: string): void;
  resumeAgent(
    request: RuntimeRequest,
    onEvent: (event: any) => void,
    onExit: (code: number | null) => void,
  ): void;
}
export class ClaudeCodeRuntime implements AgentRuntime {
  processes = new Map<string, ChildProcess>();
  startAgent(
    r: RuntimeRequest,
    onEvent: (event: any) => void,
    onExit: (code: number | null) => void,
  ) {
    if (this.processes.has(r.taskId)) throw new Error("Task already running");
    const config = {
      mcpServers: {
        crewline: {
          command: process.execPath,
          args: [
            "--import",
            import.meta.resolve("tsx"),
            fileURLToPath(new URL("./tools.ts", import.meta.url)),
          ],
          env: { CREWLINE_ENDPOINT: r.endpoint, CREWLINE_RUN_TOKEN: r.token },
        },
      },
    };
    // Disable ambient hooks, repository settings and all native tools. Only the scoped MCP tools are exposed.
    const child = spawn(
      process.env.CREWLINE_CLAUDE || "claude",
      [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-mode",
        "dontAsk",
        "--tools",
        "",
        "--allowedTools",
        "mcp__crewline__*",
        "--strict-mcp-config",
        "--mcp-config",
        JSON.stringify(config),
        "--setting-sources",
        "",
        "--settings",
        JSON.stringify({ disableAllHooks: true }),
        "--disable-slash-commands",
        "--no-chrome",
      ],
      {
        cwd: r.workspace,
        env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.processes.set(r.taskId, child);
    let done = false;
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      this.processes.delete(r.taskId);
      onExit(code);
    };
    createInterface({ input: child.stdout! }).on("line", (line) => {
      try {
        onEvent(JSON.parse(line));
      } catch {
        onEvent({ type: "log", text: line.slice(0, 8000) });
      }
    });
    child.stderr!.on("data", (buf) =>
      onEvent({ type: "log", text: buf.toString().slice(0, 8000) }),
    );
    child.once("error", (e) => {
      onEvent({ type: "result", is_error: true, result: e.message });
      finish(1);
    });
    child.once("close", finish);
    child.stdin!.on("error", () => {});
    child.stdin!.end(r.prompt);
  }
  sendTask(...args: Parameters<ClaudeCodeRuntime["startAgent"]>) {
    this.startAgent(...args);
  }
  resumeAgent(...args: Parameters<ClaudeCodeRuntime["startAgent"]>) {
    this.startAgent(...args);
  }
  getStatus(id: string) {
    return this.processes.has(id) ? ("running" as const) : ("stopped" as const);
  }
  stopAgent(id: string) {
    const child = this.processes.get(id);
    child?.kill("SIGTERM");
    if (child) {
      const timer = setTimeout(() => {
        if (this.processes.get(id) === child) child.kill("SIGKILL");
      }, 8000);
      timer.unref();
    }
  }
}
