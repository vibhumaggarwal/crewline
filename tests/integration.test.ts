import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  chmod,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { exec, git } from "../bridge/workspace";
const wait = async <T>(
  f: () => Promise<T>,
  accept: (v: T) => boolean,
  limit = 15000,
): Promise<T> => {
  const start = Date.now();
  let last: T;
  while (Date.now() - start < limit) {
    try {
      last = await f();
      if (accept(last)) return last;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out: ${JSON.stringify(last!)}`);
};
test(
  "real HTTP + WebSocket + bridge: auth, project, worktree, streaming, approval, memory, completion",
  { timeout: 45000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "crewline-e2e-")),
      cwd = resolve(".");
    const data = join(dir, "data"),
      repo = join(dir, "repo");
    const children: ChildProcess[] = [];
    let logs = "";
    const base = "http://127.0.0.1:14317";
    try {
      await mkdir(repo);
      await exec("git", ["init", repo]);
      await git(repo, ["config", "user.email", "test@crewline.local"]);
      await git(repo, ["config", "user.name", "Crewline Test"]);
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
      );
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "Fixture"]);
      const fixture = resolve("tests/fake-claude.mjs");
      await chmod(fixture, 0o755);
      const env = {
        ...process.env,
        CREWLINE_DATA: data,
        PORT: "14317",
        NODE_ENV: "production",
        CREWLINE_CLAUDE: fixture,
      };
      const launch = (file: string) => {
        const p = spawn(process.execPath, ["--import", "tsx", file], {
          cwd,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        p.stdout!.on("data", (b) => (logs += b));
        p.stderr!.on("data", (b) => (logs += b));
        children.push(p);
        return p;
      };
      launch("server/index.ts");
      await wait(
        () => fetch(base + "/api/state"),
        (r) => r.status === 401,
      );
      const { token } = JSON.parse(
        await readFile(join(data, "credentials.json"), "utf8"),
      );
      const api = async (path: string, body?: any) => {
        const res = await fetch(base + "/api/" + path, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error);
        return result;
      };
      const cross = await fetch(base + "/api/projects", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: "https://untrusted.example",
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      assert.equal(cross.status, 403);
      const bridge = spawn(
        process.execPath,
        ["--import", "tsx", "bridge/cli.ts", "connect"],
        { cwd, env, stdio: ["ignore", "pipe", "pipe"] },
      );
      bridge.stdout!.on("data", (b) => (logs += b));
      bridge.stderr!.on("data", (b) => (logs += b));
      children.push(bridge);
      await wait(
        () => api("state"),
        (s) => s.bridge.connected,
      );
      const project = await api("projects", {
        name: "Fixture",
        path: repo,
        description: "Integration fixture only",
      });
      await wait(
        () => api("state"),
        (s) => s.projects[0]?.status === "ready",
      );
      const agent = await api("agents", {
        projectId: project.id,
        name: "Backend",
        role: "Engineer",
        responsibility: "Test isolation",
        permissions: { read: true, write: true, tests: true, git: true },
      });
      const ready = await wait(
        () => api("state"),
        (s) => s.agents[0]?.status === "ready",
      );
      assert.notEqual(ready.agents[0].workspace, repo);
      const task = await api("tasks", {
        agent: agent.id,
        title: "Integration fixture",
      });
      const pending = await wait(
        () => api("state"),
        (s) => s.approvals.some((a: any) => a.status === "pending"),
      );
      assert.equal(pending.tasks[0].status, "NEEDS_APPROVAL");
      assert.match(pending.tasks[0].result, /Checking the isolated/);
      await api("approvals/" + pending.approvals[0].id, { approved: true });
      const complete = await wait(
        () => api("state"),
        (s) => s.tasks[0].status === "COMPLETED",
      );
      assert.match(complete.agents[0].memory, /fixture test passed/);
      assert.equal(complete.tasks[0].outputTokens, 7);
      assert.equal(
        await readFile(
          join(ready.agents[0].workspace, "fixture-output.txt"),
          "utf8",
        ),
        "Verified isolated worker output",
      );
      await assert.rejects(readFile(join(repo, "fixture-output.txt")));
      assert.match(
        await readFile(
          join(repo, ".agents", agent.id, "tasks", task.id + ".json"),
          "utf8",
        ),
        /COMPLETED/,
      );
      const second = await api("tasks", {
        agent: agent.id,
        title: "Rejected test fixture",
      });
      const reject = await wait(
        () => api("state"),
        (s) =>
          s.approvals.some(
            (a: any) => a.taskId === second.id && a.status === "pending",
          ),
      );
      await api(
        "approvals/" +
          reject.approvals.find((a: any) => a.taskId === second.id).id,
        { approved: false },
      );
      const failed = await wait(
        () => api("state"),
        (s) =>
          s.tasks.find((t: any) => t.id === second.id)?.status === "FAILED",
      );
      assert.match(
        failed.tasks.find((t: any) => t.id === second.id).result,
        /rejected/,
      );
      const pausedTask = await api("tasks", {
        agent: agent.id,
        title: "Pause and resume fixture",
      });
      await wait(
        () => api("state"),
        (s) =>
          s.tasks.find((t: any) => t.id === pausedTask.id)?.status ===
          "NEEDS_APPROVAL",
      );
      await api(`tasks/${pausedTask.id}/pause`, {});
      const paused = await wait(
        () => api("state"),
        (s) =>
          s.tasks.find((t: any) => t.id === pausedTask.id)?.status ===
          "WAITING",
      );
      assert.equal(
        paused.approvals.filter(
          (a: any) => a.taskId === pausedTask.id && a.status === "pending",
        ).length,
        0,
      );
      await api(`tasks/${pausedTask.id}/resume`, {});
      const resumed = await wait(
        () => api("state"),
        (s) =>
          s.approvals.some(
            (a: any) => a.taskId === pausedTask.id && a.status === "pending",
          ),
      );
      await api(
        "approvals/" +
          resumed.approvals.find(
            (a: any) => a.taskId === pausedTask.id && a.status === "pending",
          ).id,
        { approved: true },
      );
      await wait(
        () => api("state"),
        (s) =>
          s.tasks.find((t: any) => t.id === pausedTask.id)?.status ===
          "COMPLETED",
      );
      const qa = await api("agents", {
        projectId: project.id,
        name: "QA",
        role: "QA Engineer",
        responsibility: "Verify handoffs",
        permissions: { read: true, write: true, tests: true, git: true },
      });
      const qaReady = await wait(
        () => api("state"),
        (s) => s.agents.find((a: any) => a.id === qa.id)?.status === "ready",
      );
      const producer = await api("tasks", {
        agent: agent.id,
        title: "Produce handoff fixture",
      });
      const commitApproval = await wait(
        () => api("state"),
        (s) =>
          s.approvals.some(
            (a: any) => a.taskId === producer.id && a.status === "pending",
          ),
      );
      await api(
        "approvals/" +
          commitApproval.approvals.find(
            (a: any) => a.taskId === producer.id && a.status === "pending",
          ).id,
        { approved: true },
      );
      const integrationApproval = await wait(
        () => api("state"),
        (s) =>
          s.approvals.some(
            (a: any) => a.agentId === qa.id && a.status === "pending",
          ),
      );
      const handoff = integrationApproval.tasks.find(
        (t: any) => t.parent_task === producer.id,
      );
      assert.equal(handoff.sender, agent.id);
      assert.equal(handoff.status, "NEEDS_APPROVAL");
      await api(
        "approvals/" +
          integrationApproval.approvals.find(
            (a: any) => a.agentId === qa.id && a.status === "pending",
          ).id,
        { approved: true },
      );
      await wait(
        () => api("state"),
        (s) =>
          s.tasks.find((t: any) => t.id === handoff.id)?.status === "COMPLETED",
      );
      assert.equal(
        await readFile(
          join(
            qaReady.agents.find((a: any) => a.id === qa.id).workspace,
            "handoff.txt",
          ),
          "utf8",
        ),
        "Verified handoff",
      );
    } catch (e) {
      throw new Error(`${String(e)}\nProcess output:\n${logs}`);
    } finally {
      await Promise.all(
        children.map(async (p) => {
          if (p.exitCode !== null) return;
          p.kill("SIGTERM");
          await Promise.race([
            once(p, "exit"),
            new Promise((r) => setTimeout(r, 2500)),
          ]);
          if (p.exitCode === null) p.kill("SIGKILL");
        }),
      );
      await rm(dir, { recursive: true, force: true });
    }
  },
);
