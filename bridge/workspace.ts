import { promises as fs } from "node:fs";
import { resolve, join, relative, isAbsolute, dirname, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Agent, Project, Task } from "../shared/types";
export const exec = promisify(execFile);
export async function git(path: string, args: string[]) {
  return (
    await exec("git", ["-C", path, ...args], {
      maxBuffer: 4 * 1024 * 1024,
      timeout: 30000,
    })
  ).stdout.trim();
}
export async function validateProject(p: Project) {
  const path = await fs.realpath(
    p.path.replace(/^~(?=\/)/, process.env.HOME || ""),
  );
  const root = await git(path, ["rev-parse", "--show-toplevel"]);
  if (root !== path)
    throw new Error("Select the repository root, not a subfolder");
  await git(path, ["rev-parse", "HEAD"]);
  await fs.mkdir(join(path, ".agents"), { recursive: true });
  await fs
    .writeFile(
      join(path, ".agents", "project.md"),
      `# ${p.name}\n\n${p.description}\n`,
      { flag: "wx" },
    )
    .catch((e: any) => {
      if (e.code !== "EEXIST") throw e;
    });
  return path;
}
export async function prepareAgent(a: Agent, p: Project, data: string) {
  const workspace = join(data, "worktrees", p.id, a.id);
  await fs.mkdir(dirname(workspace), { recursive: true });
  try {
    await git(p.path, ["worktree", "add", "-b", a.branch, workspace, "HEAD"]);
  } catch (e) {
    const branch = await git(workspace, ["branch", "--show-current"]).catch(
      () => null,
    );
    if (branch !== a.branch) throw e;
  }
  const dir = memoryDir(a, p);
  await fs.mkdir(join(dir, "tasks"), { recursive: true });
  for (const [file, content] of Object.entries({
    "identity.md": `# ${a.name}\nRole: ${a.role}\nResponsibility: ${a.responsibility}\nBranch: ${a.branch}\nStay within your responsibility unless explicitly requested.\n`,
    "memory.md": "# Memory\n\n",
    "progress.md": "# Progress\n\nNo task started.\n",
  }))
    await fs
      .writeFile(join(dir, file), content, { flag: "wx" })
      .catch((e: any) => {
        if (e.code !== "EEXIST") throw e;
      });
  return workspace;
}
export const memoryDir = (a: Agent, p: Project) =>
  join(p.path, ".agents", a.id);
export async function readMemory(a: Agent, p: Project) {
  const dir = memoryDir(a, p);
  return {
    memory: await fs.readFile(join(dir, "memory.md"), "utf8"),
    progress: await fs.readFile(join(dir, "progress.md"), "utf8"),
  };
}
export async function context(a: Agent, p: Project, t: Task) {
  const dir = memoryDir(a, p);
  const chunks = await Promise.all(
    [
      join(p.path, ".agents", "project.md"),
      join(dir, "identity.md"),
      join(dir, "memory.md"),
      join(dir, "progress.md"),
    ].map((f) => fs.readFile(f, "utf8")),
  );
  const state = await git(a.workspace, ["status", "--short"]);
  return `${chunks.join("\n\n")}\n\nGit state:\n${state}\n\nTask: ${t.title}\n${t.description}\nContext: ${t.context || ""}\nPrevious result: ${t.result || ""}\nExpected output: ${t.expected_output || "Implement and verify the task; summarize changes and remaining work."}\n\nUse only the Crewline tools. File paths are relative to your worktree. Use save_memory to record durable findings. Use handoff to delegate follow-up work to a project worker; it runs after this task completes. Never claim an action succeeded unless its tool result confirms it. Do not deploy. Git commits and tests require a human approval.\n`;
}
export async function safePath(root: string, path: string, write = false) {
  if (isAbsolute(path)) throw new Error("Use a relative workspace path");
  const clean = path.split(/[\\/]/);
  if (clean.some((s) => [".git", ".agents", ".claude"].includes(s)))
    throw new Error("Protected runtime/configuration path");
  const base = await fs.realpath(root);
  const target = resolve(base, path);
  const inside = (p: string) => p === base || p.startsWith(base + sep);
  if (!inside(target)) throw new Error("Path escapes assigned workspace");
  let cursor = base;
  for (const part of relative(base, target).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    try {
      if ((await fs.lstat(cursor)).isSymbolicLink())
        throw new Error("Symbolic links are not allowed in worker file tools");
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  let check = target;
  while (true) {
    try {
      const real = await fs.realpath(check);
      if (!inside(real)) throw new Error("Symlink escapes assigned workspace");
      break;
    } catch (e: any) {
      if (e.code !== "ENOENT" || !write) throw e;
      const parent = dirname(check);
      if (parent === check) throw e;
      check = parent;
    }
  }
  return target;
}
