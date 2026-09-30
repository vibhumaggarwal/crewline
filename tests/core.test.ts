import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  symlink,
  rm,
  readFile,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store";
import { Coordinator } from "../server/coordinator";
import {
  safePath,
  git,
  exec,
  prepareAgent,
  context,
  validateProject,
} from "../bridge/workspace";
import type { Project, Agent, Task } from "../shared/types";
test("file boundaries reject traversal, symlinks, absolute paths, and runtime configuration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crewline-boundary-"));
  try {
    const root = join(dir, "repo");
    await mkdir(root);
    await writeFile(join(dir, "secret"), "private");
    await symlink(dir, join(root, "outside"));
    await symlink(join(dir, "missing"), join(root, "dangling"));
    assert.equal(
      await safePath(root, "nested/file.txt", true),
      join(await realpath(root), "nested/file.txt"),
    );
    await assert.rejects(safePath(root, "../secret"));
    await assert.rejects(safePath(root, join(dir, "secret")));
    await assert.rejects(safePath(root, "outside/secret"));
    await assert.rejects(safePath(root, "dangling", true));
    await assert.rejects(safePath(root, "outside/new.txt", true));
    await assert.rejects(safePath(root, ".git/config", true));
    await assert.rejects(safePath(root, ".claude/settings.json", true));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("scheduler persists dependencies, serializes each worker, and resumes after disconnection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crewline-queue-"));
  const s = new Store(join(dir, "state.sqlite"));
  try {
    const c = new Coordinator(s);
    const messages: any[] = [];
    c.send = (m) => messages.push(m);
    c.bridge = { connected: true, claude: true };
    s.put("project", { id: "p", status: "ready" });
    s.put("agent", {
      id: "a",
      projectId: "p",
      name: "Backend",
      workspace: "/test",
      status: "ready",
    });
    s.put("agent", {
      id: "b",
      projectId: "p",
      name: "QA",
      workspace: "/qa",
      status: "ready",
    });
    const first = c.createTask({ agent: "a", title: "Build API" });
    const second = c.createTask({ agent: "a", title: "Document API" });
    const handoff = c.createTask({
      agent: "b",
      title: "Test API",
      sender: "a",
      dependencies: [first.id],
    });
    assert.equal(s.get<Task>("task", first.id).status, "RUNNING");
    assert.equal(s.get<Task>("task", second.id).status, "QUEUED");
    assert.equal(s.get<Task>("task", handoff.id).status, "BLOCKED");
    assert.equal(messages.filter((m) => m.type === "run").length, 1);
    c.receive({
      type: "taskUpdate",
      id: first.id,
      patch: { status: "COMPLETED" },
    });
    assert.equal(s.get<Task>("task", handoff.id).status, "RUNNING");
    assert.equal(s.get<Task>("task", second.id).status, "RUNNING");
    c.disconnect();
    assert.equal(s.get<Task>("task", second.id).status, "WAITING");
    c.bridge = { connected: true, claude: true };
    c.control(second.id, "resume");
    assert.equal(s.get<Task>("task", second.id).status, "RUNNING");
    assert.throws(() => c.control(second.id, "resume"));
    const reboot = new Coordinator(s);
    assert.equal(
      reboot.snapshot().tasks.find((t) => t.id === second.id)?.status,
      "WAITING",
    );
  } finally {
    s.db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("worktree and memory survive new sessions independently of conversation history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crewline-git-"));
  try {
    const root = join(dir, "repo");
    await mkdir(root);
    await exec("git", ["init", root]);
    await git(root, ["config", "user.email", "test@crewline.local"]);
    await git(root, ["config", "user.name", "Crewline Test"]);
    await writeFile(join(root, "README.md"), "fixture");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "Initial fixture"]);
    const p: Project = {
      id: "project",
      name: "Test",
      path: root,
      description: "Test context",
      created_at: "",
      status: "ready",
    };
    assert.equal(await validateProject(p), await realpath(root));
    const a: Agent = {
      id: "worker",
      projectId: p.id,
      name: "Backend",
      role: "Engineer",
      responsibility: "Own APIs",
      permissions: { read: true, write: true, tests: true, git: true },
      branch: "agent/backend",
      workspace: "",
      memory: "",
      progress: "",
      status: "ready",
    };
    a.workspace = await prepareAgent(a, p, join(dir, "data"));
    await writeFile(join(a.workspace, "new.txt"), "worker output");
    assert.equal(await readFile(join(root, "README.md"), "utf8"), "fixture");
    await assert.rejects(readFile(join(root, "new.txt")));
    await writeFile(
      join(root, ".agents", a.id, "memory.md"),
      "Database uses WAL",
    );
    const prompt = await context(a, p, {
      id: "task",
      title: "Next task",
      description: "Continue",
      agent: a.id,
      projectId: p.id,
      status: "QUEUED",
      dependencies: [],
      created_at: "",
      updated_at: "",
    });
    assert.match(prompt, /Database uses WAL/);
    assert.match(prompt, /Own APIs/);
    assert.match(prompt, /new.txt/);
    assert.equal(await prepareAgent(a, p, join(dir, "data")), a.workspace);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
