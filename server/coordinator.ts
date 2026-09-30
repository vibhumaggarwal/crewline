import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  Agent,
  Task,
  Project,
  Activity,
  Approval,
  Snapshot,
} from "../shared/types";
import { Store } from "./store";
const text = z.string().trim().min(1).max(20000);
export const projectInput = z.object({
  name: text.max(80),
  path: text.max(2000),
  description: z.string().max(20000).default(""),
});
export const agentInput = z.object({
  projectId: text,
  name: text.max(60),
  role: text.max(100),
  responsibility: text,
  permissions: z.object({
    read: z.boolean(),
    write: z.boolean(),
    tests: z.boolean(),
    git: z.boolean(),
  }),
});
export const taskInput = z.object({
  agent: text,
  title: text.max(300),
  description: z.string().max(20000).default(""),
  dependencies: z.array(z.string()).max(20).default([]),
  parent_task: z.string().optional(),
  sender: z.string().optional(),
  context: z.string().max(20000).optional(),
  expected_output: z.string().max(5000).optional(),
});
export class Coordinator {
  bridge: Snapshot["bridge"] = { connected: false, claude: false };
  send: (message: unknown) => void = () => {
    throw new Error("Connect the local bridge first");
  };
  broadcast: () => void = () => {};
  constructor(public store: Store) {
    for (const t of store.all<Task>("task"))
      if (["RUNNING", "NEEDS_APPROVAL"].includes(t.status))
        store.patch<Task>("task", t.id, {
          status: "WAITING",
          result:
            "Coordinator restarted. Resume to continue from persistent context.",
        });
    for (const a of store.all<Approval>("approval"))
      if (a.status === "pending")
        store.patch<Approval>("approval", a.id, { status: "expired" });
  }
  snapshot(): Snapshot {
    return {
      projects: this.store.all("project"),
      agents: this.store.all("agent"),
      tasks: this.store.all("task"),
      events: this.store.all<Activity>("event").slice(-500),
      approvals: this.store.all("approval"),
      bridge: this.bridge,
    };
  }
  event(data: Partial<Activity> & { text: string; kind: string }) {
    this.store.put("event", {
      id: randomUUID(),
      created_at: new Date().toISOString(),
      ...data,
    });
    this.broadcast();
  }
  createProject(input: unknown) {
    if (!this.bridge.connected)
      throw new Error("Connect the local bridge before adding a repository");
    const p = this.store.put<Project>("project", {
      ...projectInput.parse(input),
      id: randomUUID(),
      created_at: new Date().toISOString(),
      status: "validating",
    });
    this.send({ type: "project", project: p });
    this.broadcast();
    return p;
  }
  createAgent(input: unknown) {
    const data = agentInput.parse(input);
    const p = this.store.get<Project>("project", data.projectId);
    if (p.status !== "ready" || !this.bridge.connected)
      throw new Error("A connected bridge and ready project are required");
    if (
      this.store
        .all<Agent>("agent")
        .some(
          (a) =>
            a.projectId === p.id &&
            a.name.toLowerCase() === data.name.toLowerCase(),
        )
    )
      throw new Error("An agent with this name already exists");
    const id = randomUUID();
    const a = this.store.put<Agent>("agent", {
      ...data,
      id,
      branch: `agent/${data.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${id.slice(0, 6)}`,
      workspace: "",
      status: "preparing",
      memory: "",
      progress: "",
    });
    this.send({ type: "agent", agent: a, project: p });
    this.broadcast();
    return a;
  }
  createTask(input: unknown) {
    const d = taskInput.parse(input);
    const a = this.store.get<Agent>("agent", d.agent);
    if (!a.workspace || a.status === "error")
      throw new Error("Agent workspace is not ready");
    for (const dep of [
      ...d.dependencies,
      ...(d.parent_task ? [d.parent_task] : []),
    ])
      if (this.store.get<Task>("task", dep).projectId !== a.projectId)
        throw new Error("Dependencies must belong to the same project");
    if (
      d.sender &&
      this.store.get<Agent>("agent", d.sender).projectId !== a.projectId
    )
      throw new Error("Sender must be in the same project");
    const now = new Date().toISOString();
    const task = this.store.put<Task>("task", {
      ...d,
      id: randomUUID(),
      projectId: a.projectId,
      status: "QUEUED",
      created_at: now,
      updated_at: now,
    });
    this.event({
      kind: d.sender ? "handoff" : "task",
      text: d.sender
        ? `${this.store.get<Agent>("agent", d.sender).name} → ${a.name}: ${d.title}`
        : `Task assigned to ${a.name}: ${d.title}`,
      agentId: a.id,
      taskId: task.id,
      projectId: a.projectId,
    });
    this.schedule();
    return task;
  }
  schedule() {
    for (const t of this.store.all<Task>("task")) {
      if (!["QUEUED", "BLOCKED"].includes(t.status)) continue;
      const ready = t.dependencies.every(
        (id) => this.store.get<Task>("task", id).status === "COMPLETED",
      );
      if (!ready) {
        this.store.patch<Task>("task", t.id, { status: "BLOCKED" });
        continue;
      }
      if (t.status === "BLOCKED")
        this.store.patch<Task>("task", t.id, { status: "QUEUED" });
      if (!this.bridge.connected || !this.bridge.claude) continue;
      if (
        this.store
          .all<Task>("task")
          .some(
            (o) =>
              o.agent === t.agent &&
              ["RUNNING", "NEEDS_APPROVAL", "WAITING"].includes(o.status),
          )
      )
        continue;
      const a = this.store.get<Agent>("agent", t.agent);
      const running = this.store.patch<Task>("task", t.id, {
        status: "RUNNING",
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      try {
        this.send({
          type: "run",
          task: running,
          agent: a,
          project: this.store.get<Project>("project", a.projectId),
        });
      } catch {
        this.store.patch<Task>("task", t.id, { status: "QUEUED" });
      }
    }
    this.broadcast();
  }
  control(id: string, action: string) {
    const t = this.store.get<Task>("task", id);
    if (!this.bridge.connected)
      throw new Error("Connect the local bridge first");
    if (action === "pause") {
      if (!["RUNNING", "NEEDS_APPROVAL"].includes(t.status))
        throw new Error("Only a running task can be paused");
      this.send({ type: "pause", taskId: id });
    } else if (action === "resume") {
      if (!["WAITING", "FAILED"].includes(t.status))
        throw new Error("This task cannot be resumed");
      this.store.patch<Task>("task", id, {
        status: "QUEUED",
        result: undefined,
      });
      this.schedule();
    } else throw new Error("Unknown action");
  }
  decide(id: string, approved: boolean) {
    const a = this.store.get<Approval>("approval", id);
    if (a.status !== "pending") throw new Error("Approval already resolved");
    if (!this.bridge.connected)
      throw new Error("Bridge disconnected; approval cannot be delivered");
    this.send({ type: "decision", id, approved });
    this.store.patch<Approval>("approval", id, {
      status: approved ? "approved" : "rejected",
    });
    this.broadcast();
  }
  receive(m: any) {
    if (m.type === "hello") {
      this.bridge = {
        connected: true,
        claude: !!m.claude,
        version: m.version,
        hostname: m.hostname,
      };
      for (const p of this.store.all<Project>("project"))
        if (p.status === "validating")
          this.send({ type: "project", project: p });
      for (const a of this.store.all<Agent>("agent"))
        if (a.status === "preparing")
          this.send({
            type: "agent",
            agent: a,
            project: this.store.get("project", a.projectId),
          });
      this.schedule();
    }
    if (m.type === "projectReady")
      this.store.patch<Project>("project", m.id, {
        status: m.error ? "error" : "ready",
        path: m.path,
        error: m.error,
      });
    if (m.type === "agentReady")
      this.store.patch<Agent>("agent", m.id, {
        status: m.error ? "error" : "ready",
        workspace: m.workspace,
        error: m.error,
      });
    if (m.type === "memory") {
      this.store.patch<Agent>("agent", m.id, {
        memory: m.memory,
        progress: m.progress,
      });
    }
    if (m.type === "event") this.event(m.event);
    if (m.type === "approval") {
      this.store.put<Approval>("approval", m.approval);
      this.store.patch<Task>("task", m.approval.taskId, {
        status: "NEEDS_APPROVAL",
      });
    }
    if (m.type === "approvalDone") {
      const a = this.store.get<Approval>("approval", m.id);
      if (a.status === "pending")
        this.store.patch<Approval>("approval", m.id, { status: "expired" });
      const t = this.store.get<Task>("task", a.taskId);
      if (t.status === "NEEDS_APPROVAL")
        this.store.patch<Task>("task", a.taskId, { status: "RUNNING" });
    }
    if (m.type === "taskUpdate") {
      this.store.patch<Task>("task", m.id, {
        ...m.patch,
        updated_at: new Date().toISOString(),
      });
      if (["COMPLETED", "FAILED", "WAITING"].includes(m.patch.status))
        this.schedule();
    }
    if (m.type === "handoff") {
      const parent = this.store.get<Task>("task", m.taskId);
      const recipient = this.store.get<Agent>("agent", m.recipient);
      if (recipient.projectId !== parent.projectId)
        throw new Error("Cross-project handoff denied");
      this.createTask({
        agent: m.recipient,
        title: m.title,
        description: m.objective,
        context: m.context,
        expected_output: m.expected_output,
        sender: parent.agent,
        parent_task: parent.id,
        dependencies: [parent.id],
      });
    }
    this.broadcast();
  }
  disconnect() {
    this.bridge = { connected: false, claude: false };
    for (const t of this.store.all<Task>("task"))
      if (["RUNNING", "NEEDS_APPROVAL"].includes(t.status))
        this.store.patch<Task>("task", t.id, {
          status: "WAITING",
          result: "Local bridge disconnected. Reconnect, then resume.",
        });
    for (const a of this.store.all<Approval>("approval"))
      if (a.status === "pending")
        this.store.patch<Approval>("approval", a.id, { status: "expired" });
    this.broadcast();
  }
}
