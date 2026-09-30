import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  Bell,
  Bot,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Circle,
  Command,
  Copy,
  Folder,
  GitBranch,
  Layers,
  LayoutGrid,
  ListTodo,
  Loader2,
  Menu,
  MessageSquare,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Terminal,
  Users,
  Workflow,
  X,
  Zap,
} from "lucide-react";
import type { Agent, Approval, Project, Snapshot, Task } from "../shared/types";
import "./style.css";
const empty: Snapshot = {
  projects: [],
  agents: [],
  tasks: [],
  events: [],
  approvals: [],
  bridge: { connected: false, claude: false },
};
async function api(path: string, body?: unknown) {
  const res = await fetch(
    `/api/${path}`,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const result = await res.json();
  if (!res.ok) throw new Error(result.error || "Request failed");
  return result;
}
const names: Record<string, string> = {
  CREATED: "Created",
  QUEUED: "Queued",
  RUNNING: "Working",
  BLOCKED: "Blocked",
  WAITING: "Paused",
  COMPLETED: "Completed",
  FAILED: "Failed",
  NEEDS_APPROVAL: "Needs you",
  ready: "Available",
  preparing: "Preparing",
  error: "Error",
};
const tone = (status: string) =>
  ["RUNNING"].includes(status)
    ? "green"
    : ["NEEDS_APPROVAL", "WAITING", "BLOCKED"].includes(status)
      ? "amber"
      : status === "FAILED" || status === "error"
        ? "red"
        : status === "COMPLETED"
          ? "purple"
          : "muted";
function Badge({ status }: { status: string }) {
  return (
    <span className={`badge ${tone(status)}`}>
      <span className="dot" />
      {names[status] || status}
    </span>
  );
}
const ago = (date: string) => {
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(date)) / 60000),
  );
  return minutes < 1
    ? "Just now"
    : minutes < 60
      ? `${minutes}m ago`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h ago`
        : new Date(date).toLocaleDateString();
};
const initials = (name: string) =>
  name
    .split(" ")
    .map((s) => s[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
const activeTask = (a: Agent, tasks: Task[]) =>
  tasks.find(
    (t) =>
      t.agent === a.id &&
      ["RUNNING", "NEEDS_APPROVAL", "WAITING"].includes(t.status),
  ) || tasks.filter((t) => t.agent === a.id).at(-1);
const icons = [Layers, Command, ShieldCheck, Workflow, Bot];
function Avatar({
  agent,
  index = 0,
  small = false,
}: {
  agent: Agent;
  index?: number;
  small?: boolean;
}) {
  const Icon = icons[index % icons.length];
  return (
    <span className={`avatar color-${index % 5} ${small ? "small" : ""}`}>
      <Icon size={small ? 16 : 21} />
    </span>
  );
}
function App() {
  const [state, setState] = useState<Snapshot>(empty),
    [authenticated, setAuthenticated] = useState<boolean | null>(null),
    [page, setPage] = useState("Command Center"),
    [projectId, setProjectId] = useState("all"),
    [agentId, setAgentId] = useState<string | null>(null),
    [tab, setTab] = useState("Overview"),
    [modal, setModal] = useState<
      "project" | "agent" | "task" | "connect" | "handoff" | null
    >(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [search, setSearch] = useState(""),
    [filter, setFilter] = useState("All workers"),
    [sidebar, setSidebar] = useState(false),
    [selectedTask, setSelectedTask] = useState<Task | null>(null),
    [busy, setBusy] = useState(false),
    [memory, setMemory] = useState(""),
    [stream, setStream] = useState(false);
  const [command, setCommand] = useState(""),
    [commandAgent, setCommandAgent] = useState("");
  const commandRef = useRef<HTMLTextAreaElement>(null);
  const initialSession = useRef<Promise<Snapshot> | null>(null);
  useEffect(() => {
    if (!modal && !selectedTask) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    if (!dialog) return;
    const controls = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,[tabindex="0"]',
        ),
      );
    if (!dialog.contains(document.activeElement)) controls()[0]?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const elements = controls(),
        first = elements[0],
        last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    dialog.addEventListener("keydown", trap);
    return () => {
      dialog.removeEventListener("keydown", trap);
      previous?.focus();
    };
  }, [modal, selectedTask]);
  useEffect(() => {
    let source: EventSource | undefined;
    let disposed = false;
    async function init() {
      try {
        initialSession.current ??= (async () => {
          const token = new URLSearchParams(location.hash.slice(1)).get(
            "token",
          );
          if (token) {
            history.replaceState(null, "", location.pathname);
            await api("session", { token });
          }
          return api("state");
        })();
        const data = await initialSession.current;
        if (disposed) return;
        setState(data);
        setAuthenticated(true);
        source = new EventSource("/api/events");
        source.onopen = () => setStream(true);
        source.onmessage = (e) => setState(JSON.parse(e.data));
        source.onerror = () => setStream(false);
      } catch {
        if (!disposed) setAuthenticated(false);
      }
    }
    void init();
    const timer = setInterval(() => setState((s) => ({ ...s })), 30000);
    return () => {
      disposed = true;
      source?.close();
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        commandRef.current?.focus();
      }
      if (e.key === "Escape") {
        setModal(null);
        setSelectedTask(null);
      }
    };
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, []);
  useEffect(() => {
    if (notice) {
      const t = setTimeout(() => setNotice(""), 4000);
      return () => clearTimeout(t);
    }
  }, [notice]);
  const project = state.projects.find((p) => p.id === projectId);
  const agents = state.agents.filter(
    (a) => projectId === "all" || a.projectId === projectId,
  );
  const tasks = state.tasks.filter(
    (t) => projectId === "all" || t.projectId === projectId,
  );
  const events = state.events.filter(
    (e) => projectId === "all" || e.projectId === projectId,
  );
  const approvals = state.approvals.filter(
    (a) => a.status === "pending" && tasks.some((t) => t.id === a.taskId),
  );
  const agent = state.agents.find((a) => a.id === agentId);
  const current = agent ? activeTask(agent, state.tasks) : undefined;
  const working = tasks.filter((t) => t.status === "RUNNING").length,
    waiting = tasks.filter((t) =>
      ["WAITING", "BLOCKED", "QUEUED"].includes(t.status),
    ).length;
  const navigate = (p: string) => {
    setPage(p);
    setAgentId(null);
    setSidebar(false);
    setSearch("");
  };
  const viewAgent = (a: Agent) => {
    setAgentId(a.id);
    setTab("Overview");
    setMemory(a.memory);
  };
  async function act(path: string, body: unknown, success?: string) {
    setBusy(true);
    setError("");
    try {
      const result = await api(path, body);
      if (success) setNotice(success);
      return result;
    } catch (e) {
      setError((e as Error).message);
      throw e;
    } finally {
      setBusy(false);
    }
  }
  const action = (path: string, body: unknown, success?: string) =>
    void act(path, body, success).catch(() => {});
  const runCommand = async () => {
    const target = commandAgent || agents.find((a) => a.workspace)?.id;
    if (!target) {
      setModal("agent");
      return;
    }
    if (!command.trim()) return;
    try {
      await act(
        "tasks",
        {
          agent: target,
          title: command.trim().slice(0, 300),
          description: command,
        },
        "Task added to the queue",
      );
      setCommand("");
    } catch {}
  };
  const taskRows = (items: Task[]) =>
    items.length ? (
      <div className="task-list">
        <div className="table-head">
          <span>Task</span>
          <span>Worker</span>
          <span>Status</span>
          <span>Updated</span>
        </div>
        {[...items].reverse().map((t) => (
          <button
            className="task-row"
            key={t.id}
            onClick={() => setSelectedTask(t)}
          >
            <span>
              <ListTodo size={15} />
              <span>
                <strong>{t.title}</strong>
                {t.sender && (
                  <small>
                    Handoff from{" "}
                    {state.agents.find((a) => a.id === t.sender)?.name}
                  </small>
                )}
              </span>
            </span>
            <span>{state.agents.find((a) => a.id === t.agent)?.name}</span>
            <Badge status={t.status} />
            <span className="subtle">{ago(t.updated_at)}</span>
          </button>
        ))}
      </div>
    ) : (
      <Empty
        icon={ListTodo}
        title="A clear runway"
        text="Assign a task to a worker. Its progress and results will live here."
        action="Create task"
        onClick={() => setModal("task")}
      />
    );
  const activity = (items = events) =>
    items.length ? (
      <div className="activity-list">
        {[...items]
          .reverse()
          .slice(0, 60)
          .map((e) => (
            <div className="activity-row" key={e.id}>
              <span
                className={`event-icon ${e.kind === "success" ? "green" : e.kind === "error" ? "red" : ""}`}
              >
                {e.kind === "success" ? (
                  <Check size={14} />
                ) : e.kind === "handoff" ? (
                  <ArrowUpRight size={14} />
                ) : e.kind === "approval" ? (
                  <ShieldCheck size={14} />
                ) : (
                  <Activity size={14} />
                )}
              </span>
              <div>
                <p>{e.text}</p>
                <small>
                  {state.agents.find((a) => a.id === e.agentId)?.name ||
                    "Workspace"}{" "}
                  <span>·</span> {ago(e.created_at)}
                </small>
                {e.raw && (
                  <details>
                    <summary>Logs</summary>
                    <pre>{e.raw}</pre>
                  </details>
                )}
              </div>
            </div>
          ))}
      </div>
    ) : (
      <div className="quiet">
        <Activity size={22} />
        <p>Your team’s activity will appear here.</p>
        <small>Real events, streamed from your local workspace.</small>
      </div>
    );
  const approvalCard = (a: Approval) => (
    <div className="approval-card" key={a.id}>
      <ShieldCheck size={18} />
      <div>
        <strong>{a.title}</strong>
        <p>Review this action before your worker continues.</p>
        <details>
          <summary>View requested action</summary>
          <pre>{a.detail}</pre>
        </details>
      </div>
      <div className="button-row">
        <button
          disabled={busy}
          onClick={() =>
            action(`approvals/${a.id}`, { approved: false }, "Action rejected")
          }
        >
          Reject
        </button>
        <button
          className="primary"
          disabled={busy}
          onClick={() =>
            action(`approvals/${a.id}`, { approved: true }, "Action approved")
          }
        >
          Approve
        </button>
      </div>
    </div>
  );
  if (authenticated === null)
    return (
      <div className="login">
        <div className="brand-mark">V</div>
        <Loader2 className="spin" size={20} />
        <p>Opening your workspace…</p>
      </div>
    );
  if (!authenticated)
    return (
      <div className="login">
        <div className="brand-mark">V</div>
        <h1>Your team. One workspace.</h1>
        <p>Connect this browser to Crewline on your machine.</p>
        <div className="login-panel">
          <span className="eyebrow">From your Crewline project folder</span>
          <code>npm run login</code>
          <p>
            This opens a private login link. Then connect your runtime with{" "}
            <code>npm run connect</code>.
          </p>
          <button onClick={() => location.reload()}>
            I’ve connected <ArrowRight size={16} />
          </button>
        </div>
        <small>Local by design. Your repositories stay on your machine.</small>
      </div>
    );
  return (
    <div className="app-shell">
      {sidebar && (
        <div className="sidebar-scrim" onClick={() => setSidebar(false)} />
      )}
      <aside
        className={sidebar ? "sidebar open" : "sidebar"}
        inert={!!modal || !!selectedTask}
      >
        <button
          className="workspace-switch"
          onClick={() => {
            setProjectId("all");
            navigate("Command Center");
          }}
        >
          <span className="brand-mark">V</span>
          <span>
            Crewline<small>Personal workspace</small>
          </span>
          <ChevronDown size={14} />
        </button>
        <div className="nav-group">
          {[
            [LayoutGrid, "Home"],
            [Command, "Command Center"],
            [Users, "Agents"],
            [ListTodo, "Tasks"],
            [Folder, "Projects"],
          ].map(([Icon, label]: any) => (
            <button
              key={label}
              className={`nav-item ${page === label && !agent ? "selected" : ""}`}
              onClick={() => navigate(label)}
            >
              <Icon size={17} />
              <span>{label}</span>
              {label === "Tasks" &&
                tasks.filter((t) => !["COMPLETED", "FAILED"].includes(t.status))
                  .length > 0 && (
                  <b>
                    {
                      tasks.filter(
                        (t) => !["COMPLETED", "FAILED"].includes(t.status),
                      ).length
                    }
                  </b>
                )}
              {label === "Command Center" && <kbd>⌘ K</kbd>}
            </button>
          ))}
        </div>
        <div className="nav-group">
          <div className="nav-label">
            Workspaces
            <button
              aria-label="Add workspace"
              onClick={() => setModal("project")}
            >
              <Plus size={14} />
            </button>
          </div>
          {state.projects.map((p, i) => (
            <button
              className={`nav-item ${projectId === p.id ? "project-selected" : ""}`}
              key={p.id}
              onClick={() => {
                setProjectId(p.id);
                navigate("Command Center");
              }}
            >
              <span className={`project-dot color-${i % 5}`} />
              <span>{p.name}</span>
              {projectId === p.id && <ChevronRight size={13} />}
            </button>
          ))}
          {!state.projects.length && (
            <button
              className="nav-item muted"
              onClick={() => setModal("project")}
            >
              <Plus size={16} /> Add a project
            </button>
          )}
        </div>
        <div className="nav-group">
          <div className="nav-label">Activity</div>
          {[
            [Activity, "Runs"],
            [MessageSquare, "Agent Messages"],
            [Zap, "Usage"],
          ].map(([Icon, label]: any) => (
            <button
              key={label}
              className={`nav-item ${page === label && !agent ? "selected" : ""}`}
              onClick={() => navigate(label)}
            >
              <Icon size={17} />
              {label}
            </button>
          ))}
        </div>
        <div className="sidebar-bottom">
          <button
            className={`connection-chip ${state.bridge.connected ? "online" : ""}`}
            onClick={() => setModal("connect")}
          >
            <span className="dot" />
            <span>
              Local runtime
              <small>
                {state.bridge.connected
                  ? "Connected to your machine"
                  : "Waiting for connection"}
              </small>
            </span>
            <ChevronRight size={14} />
          </button>
          <button className="nav-item" onClick={() => navigate("Settings")}>
            <Settings size={17} />
            Settings
          </button>
          <div className="user">
            <span>VA</span>
            <div>
              Vibhum Aggarwal<small>Personal account</small>
            </div>
            <MoreHorizontal size={18} />
          </div>
        </div>
      </aside>
      <div className="main-shell" inert={!!modal || !!selectedTask}>
        <header className="topbar">
          <button
            className="mobile-toggle icon-button"
            aria-label="Open navigation"
            onClick={() => setSidebar(true)}
          >
            <Menu size={19} />
          </button>
          <span className="breadcrumb">
            Workspace <ChevronRight size={13} />{" "}
            <button
              onClick={() => {
                setProjectId("all");
                setAgentId(null);
              }}
            >
              {project?.name || "All projects"}
            </button>{" "}
            <ChevronRight size={13} />
            <strong>{agent?.name || page}</strong>
          </span>
          <div className="topbar-right">
            <span className={`sync ${stream ? "" : "offline"}`}>
              <span className="dot" />
              {stream ? "Live updates" : "Reconnecting"}
            </span>
            <button
              className="icon-button"
              aria-label="View approvals"
              onClick={() => navigate("Home")}
            >
              <Bell size={17} />
              {approvals.length > 0 && <i />}
            </button>
            <span className="user-mini">VA</span>
          </div>
        </header>
        <main>
          {error && (
            <div className="error-banner" role="alert">
              {error}
              <button
                className="icon-button"
                aria-label="Dismiss error"
                onClick={() => setError("")}
              >
                <X size={15} />
              </button>
            </div>
          )}
          {agent ? (
            <>
              <button className="back" onClick={() => setAgentId(null)}>
                ← All workers
              </button>
              <div className="page-heading agent-heading">
                <Avatar agent={agent} index={state.agents.indexOf(agent)} />
                <div>
                  <h1>{agent.name}</h1>
                  <p>{agent.role}</p>
                </div>
                <Badge status={current?.status || agent.status} />
                <button
                  className="primary"
                  onClick={() => {
                    setCommandAgent(agent.id);
                    setModal("task");
                  }}
                >
                  <Plus size={16} />
                  Assign task
                </button>
              </div>
              <div className="agent-meta">
                <span>
                  <Folder size={14} />
                  {agent.workspace || "Preparing workspace"}
                </span>
                <span>
                  <GitBranch size={14} />
                  {agent.branch}
                </span>
              </div>
              <div className="tabs">
                {["Overview", "Tasks", "Memory", "Activity"].map((t) => (
                  <button
                    className={tab === t ? "active" : ""}
                    key={t}
                    onClick={() => {
                      setTab(t);
                      if (t === "Memory") setMemory(agent.memory);
                    }}
                  >
                    {t}
                    {t === "Tasks" && (
                      <span>
                        {state.tasks.filter((t) => t.agent === agent.id).length}
                      </span>
                    )}
                  </button>
                ))}
              </div>
              {tab === "Overview" && (
                <div className="detail-grid">
                  <div>
                    <section className="panel current-task">
                      <div className="section-heading">
                        <h2>Current task</h2>
                        {current && <Badge status={current.status} />}
                      </div>
                      <h3>{current?.title || "Ready for the next thing"}</h3>
                      <p>{current?.description || agent.responsibility}</p>
                      {current && (
                        <>
                          <div className="button-row">
                            {["RUNNING", "NEEDS_APPROVAL"].includes(
                              current.status,
                            ) && (
                              <button
                                onClick={() =>
                                  action(
                                    `tasks/${current.id}/pause`,
                                    {},
                                    "Pausing worker…",
                                  )
                                }
                              >
                                <Pause size={14} />
                                Pause
                              </button>
                            )}
                            {["WAITING", "FAILED"].includes(current.status) && (
                              <button
                                onClick={() =>
                                  action(
                                    `tasks/${current.id}/resume`,
                                    {},
                                    "Task queued to resume",
                                  )
                                }
                              >
                                <Play size={14} />
                                Resume
                              </button>
                            )}
                            <button
                              onClick={() => {
                                setSelectedTask(current);
                                setModal("handoff");
                              }}
                            >
                              <ArrowUpRight size={14} />
                              Handoff
                            </button>
                            <button onClick={() => setSelectedTask(current)}>
                              Task details
                            </button>
                          </div>
                          <div className="latest-output">
                            <span className="eyebrow">Latest output</span>
                            <pre>
                              {current.result ||
                                "Waiting for Claude Code output…"}
                            </pre>
                          </div>
                        </>
                      )}
                    </section>
                    <section className="panel">
                      <div className="section-heading">
                        <h2>Recent activity</h2>
                        <Activity size={16} />
                      </div>
                      {activity(events.filter((e) => e.agentId === agent.id))}
                    </section>
                  </div>
                  <div>
                    <section className="panel">
                      <h2>Worker context</h2>
                      <dl>
                        <dt>Runtime</dt>
                        <dd>Claude Code</dd>
                        <dt>Responsibility</dt>
                        <dd>{agent.responsibility}</dd>
                        <dt>Isolation</dt>
                        <dd>Dedicated Git worktree</dd>
                        <dt>Permissions</dt>
                        <dd className="permission-tags">
                          {Object.entries(agent.permissions)
                            .filter(([, v]) => v)
                            .map(([k]) => (
                              <span key={k}>{k}</span>
                            ))}
                        </dd>
                      </dl>
                    </section>
                    <section className="panel">
                      <h2>Files changed</h2>
                      {current?.files?.length ? (
                        <ul className="file-list">
                          {current.files.map((f) => (
                            <li key={f}>{f}</li>
                          ))}
                        </ul>
                      ) : (
                        <p className="subtle">
                          File summary is recorded when the run finishes.
                        </p>
                      )}
                      {current?.git_commit && (
                        <div className="commit">
                          <GitBranch size={14} />
                          {current.git_commit.slice(0, 7)}
                        </div>
                      )}
                    </section>
                  </div>
                </div>
              )}
              {tab === "Tasks" &&
                taskRows(state.tasks.filter((t) => t.agent === agent.id))}
              {tab === "Memory" && (
                <section className="panel memory-panel">
                  <div className="section-heading">
                    <div>
                      <h2>Persistent memory</h2>
                      <p>
                        Carried into every new session. Stored in your project’s
                        .agents directory.
                      </p>
                    </div>
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() =>
                        action(
                          `agents/${agent.id}/memory`,
                          { memory },
                          "Memory saved",
                        )
                      }
                    >
                      <Check size={15} />
                      Save memory
                    </button>
                  </div>
                  <textarea
                    aria-label="Agent memory"
                    value={memory}
                    onChange={(e) => setMemory(e.target.value)}
                  />
                  <h2>Progress</h2>
                  <pre>{agent.progress || "No progress recorded yet."}</pre>
                </section>
              )}
              {tab === "Activity" && (
                <section className="panel">
                  {activity(events.filter((e) => e.agentId === agent.id))}
                </section>
              )}
            </>
          ) : (
            <>
              <div className="page-heading">
                <div>
                  <div className="date-line">
                    {new Date().toLocaleDateString("en-US", {
                      weekday: "long",
                      month: "long",
                      day: "numeric",
                    })}
                  </div>
                  <h1>
                    {page === "Home" || page === "Command Center"
                      ? `${new Date().getHours() < 12 ? "Good morning" : new Date().getHours() < 18 ? "Good afternoon" : "Good evening"}, Vibhum`
                      : page}
                  </h1>
                  <p>
                    {page === "Home" || page === "Command Center" ? (
                      <>
                        Your team, in motion.{" "}
                        <span className="heading-summary">
                          {working} working <span>·</span> {waiting} waiting{" "}
                          <span>·</span> {approvals.length} needs you
                        </span>
                      </>
                    ) : page === "Agents" ? (
                      "Persistent workers. A clear responsibility for each."
                    ) : page === "Tasks" ? (
                      "From the first instruction to the final result."
                    ) : page === "Projects" ? (
                      "Your repositories, connected to a dedicated team."
                    ) : page === "Agent Messages" ? (
                      "Clear handoffs between your workers."
                    ) : page === "Usage" ? (
                      "Runtime usage reported by completed Claude Code sessions."
                    ) : page === "Settings" ? (
                      "Your local workspace and runtime connection."
                    ) : (
                      "A live record of what your team is doing."
                    )}
                  </p>
                </div>
                <div className="button-row">
                  {["Home", "Command Center", "Agents"].includes(page) ? (
                    <button
                      className="primary"
                      onClick={() => setModal("agent")}
                    >
                      <Plus size={16} />
                      Create agent
                    </button>
                  ) : page === "Projects" ? (
                    <button
                      className="primary"
                      onClick={() => setModal("project")}
                    >
                      <Plus size={16} />
                      New project
                    </button>
                  ) : page === "Tasks" ? (
                    <button
                      className="primary"
                      onClick={() => setModal("task")}
                    >
                      <Plus size={16} />
                      New task
                    </button>
                  ) : null}
                </div>
              </div>
              {["Home", "Command Center"].includes(page) && (
                <>
                  <div className="overview-strip">
                    <div>
                      <span className="stat-icon purple">
                        <Users size={18} />
                      </span>
                      <span>
                        <strong>{agents.length}</strong>
                        <small>Total workers</small>
                      </span>
                    </div>
                    <div>
                      <span className="stat-icon green">
                        <Activity size={18} />
                      </span>
                      <span>
                        <strong>
                          {working}
                          <span className="stat-caption">live</span>
                        </strong>
                        <small>Working now</small>
                      </span>
                    </div>
                    <div>
                      <span className="stat-icon amber">
                        <ShieldCheck size={18} />
                      </span>
                      <span>
                        <strong>{approvals.length}</strong>
                        <small>Needs your attention</small>
                      </span>
                    </div>
                    <div>
                      <span className="stat-icon muted">
                        <CheckCheck size={18} />
                      </span>
                      <span>
                        <strong>
                          {tasks.filter((t) => t.status === "COMPLETED").length}
                        </strong>
                        <small>Tasks completed</small>
                      </span>
                    </div>
                  </div>
                  {approvals.map(approvalCard)}
                  {!state.bridge.connected && (
                    <div className="connection-banner">
                      <span className="connection-glyph">
                        <Terminal size={20} />
                      </span>
                      <div>
                        <strong>Bring your local workspace online</strong>
                        <p>
                          Connect the runtime to give your workers a place to
                          work.
                        </p>
                      </div>
                      <button onClick={() => setModal("connect")}>
                        Connect runtime <ArrowRight size={14} />
                      </button>
                    </div>
                  )}
                </>
              )}
              {["Home", "Command Center", "Agents"].includes(page) && (
                <>
                  <div className="section-heading workers-heading">
                    <h2>
                      Your workers{" "}
                      <span className="count">{agents.length}</span>
                    </h2>
                    <div className="button-row">
                      <div className="search">
                        <Search size={14} />
                        <input
                          aria-label="Search workers"
                          value={search}
                          onChange={(e) => setSearch(e.target.value)}
                          placeholder="Find a worker…"
                        />
                      </div>
                      <select
                        aria-label="Worker status"
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                      >
                        <option>All workers</option>
                        <option>Working</option>
                        <option>Needs you</option>
                        <option>Available</option>
                      </select>
                    </div>
                  </div>
                  {agents.length ? (
                    <div className="agent-grid">
                      {agents
                        .filter((a) =>
                          `${a.name} ${a.role}`
                            .toLowerCase()
                            .includes(search.toLowerCase()),
                        )
                        .filter(
                          (a) =>
                            filter === "All workers" ||
                            names[
                              activeTask(a, state.tasks)?.status || a.status
                            ] === filter,
                        )
                        .map((a) => {
                          const t = activeTask(a, state.tasks),
                            status = t?.status || a.status;
                          return (
                            <article
                              className={`agent-card ${status === "RUNNING" ? "working" : ""}`}
                              key={a.id}
                            >
                              <div className="card-top">
                                <Avatar
                                  agent={a}
                                  index={state.agents.indexOf(a)}
                                />
                                <Badge status={status} />
                                <button
                                  className="icon-button"
                                  aria-label={`View ${a.name}`}
                                  onClick={() => viewAgent(a)}
                                >
                                  <MoreHorizontal size={18} />
                                </button>
                              </div>
                              <button
                                className="card-title"
                                onClick={() => viewAgent(a)}
                              >
                                <h3>{a.name}</h3>
                                <p>{a.role}</p>
                              </button>
                              <div className="card-task">
                                <span>
                                  {t ? "Latest task" : "Responsibility"}
                                </span>
                                <p>{a.error || t?.title || a.responsibility}</p>
                              </div>
                              <div className={`run-track ${tone(status)}`}>
                                <span
                                  style={{
                                    width:
                                      status === "COMPLETED"
                                        ? "100%"
                                        : status === "RUNNING"
                                          ? "100%"
                                          : "0%",
                                  }}
                                />
                              </div>
                              <div className="card-meta">
                                <span>
                                  <span className="claude-symbol">✳</span>{" "}
                                  Claude Code
                                </span>
                                <small>
                                  {t?.status === "RUNNING"
                                    ? `Started ${ago(t.started_at || t.created_at)}`
                                    : t?.status === "COMPLETED"
                                      ? "Task completed"
                                      : a.workspace
                                        ? "Workspace ready"
                                        : "Preparing"}
                                </small>
                              </div>
                              <div className="card-footer">
                                <span
                                  title={
                                    state.projects.find(
                                      (p) => p.id === a.projectId,
                                    )?.path
                                  }
                                >
                                  <span className="project-dot" />
                                  {
                                    state.projects.find(
                                      (p) => p.id === a.projectId,
                                    )?.name
                                  }
                                </span>
                                <div>
                                  <button onClick={() => viewAgent(a)}>
                                    View <ArrowUpRight size={13} />
                                  </button>
                                  {t &&
                                  ["RUNNING", "NEEDS_APPROVAL"].includes(
                                    t.status,
                                  ) ? (
                                    <button
                                      aria-label={`Pause ${a.name}`}
                                      onClick={() =>
                                        action(`tasks/${t.id}/pause`, {})
                                      }
                                    >
                                      <Pause size={13} />
                                    </button>
                                  ) : (
                                    <button
                                      aria-label={`Assign task to ${a.name}`}
                                      onClick={() => {
                                        setCommandAgent(a.id);
                                        setModal("task");
                                      }}
                                    >
                                      <Plus size={14} />
                                    </button>
                                  )}
                                </div>
                              </div>
                            </article>
                          );
                        })}
                      <button
                        className="add-agent-card"
                        onClick={() => setModal("agent")}
                      >
                        <span>
                          <Plus size={21} />
                        </span>
                        <strong>Add a teammate</strong>
                        <p>
                          Give a worker a role.
                          <br />
                          Let it take ownership.
                        </p>
                      </button>
                    </div>
                  ) : (
                    <div className="onboarding">
                      <div className="onboarding-art">
                        <span>
                          <Layers size={25} />
                        </span>
                        <span>
                          <Command size={30} />
                        </span>
                        <span>
                          <ShieldCheck size={25} />
                        </span>
                      </div>
                      <h2>A workspace for your AI team</h2>
                      <p>
                        Connect a repository, create your first worker,
                        <br />
                        and turn a simple instruction into progress.
                      </p>
                      <button
                        className="primary"
                        onClick={() =>
                          setModal(
                            state.projects.some((p) => p.status === "ready")
                              ? "agent"
                              : "project",
                          )
                        }
                      >
                        <Plus size={16} />
                        {state.projects.some((p) => p.status === "ready")
                          ? "Create your first worker"
                          : "Add your first project"}
                      </button>
                      <div className="setup-steps">
                        <span className={state.bridge.connected ? "done" : ""}>
                          <Check size={13} />
                          Connect runtime
                        </span>
                        <ChevronRight size={12} />
                        <span className={state.projects.length ? "done" : ""}>
                          <Folder size={13} />
                          Add repository
                        </span>
                        <ChevronRight size={12} />
                        <span>
                          <Users size={13} />
                          Create worker
                        </span>
                      </div>
                    </div>
                  )}
                </>
              )}
              {["Home", "Command Center"].includes(page) && (
                <div className="bottom-grid">
                  <section className="panel">
                    <div className="section-heading">
                      <h2>Recent activity</h2>
                      <button
                        className="text-button"
                        onClick={() => navigate("Runs")}
                      >
                        View all <ArrowRight size={13} />
                      </button>
                    </div>
                    {activity(events.filter((e) => e.kind !== "log").slice(-5))}
                  </section>
                  <section className="panel">
                    <div className="section-heading">
                      <h2>Team handoffs</h2>
                      <ArrowDownLeft size={16} />
                    </div>
                    {tasks.some((t) => t.sender) ? (
                      [...tasks]
                        .filter((t) => t.sender)
                        .reverse()
                        .slice(0, 4)
                        .map((t) => (
                          <button
                            className="handoff-row"
                            key={t.id}
                            onClick={() => setSelectedTask(t)}
                          >
                            <span>
                              {
                                state.agents.find((a) => a.id === t.sender)
                                  ?.name
                              }
                              <ArrowRight size={13} />
                              {state.agents.find((a) => a.id === t.agent)?.name}
                            </span>
                            <p>{t.title}</p>
                            <Badge status={t.status} />
                          </button>
                        ))
                    ) : (
                      <div className="quiet">
                        <Workflow size={23} />
                        <p>Better work, together.</p>
                        <small>
                          Worker handoffs will appear here when tasks
                          <br />
                          are passed to a teammate.
                        </small>
                      </div>
                    )}
                  </section>
                </div>
              )}
              {page === "Tasks" && taskRows(tasks)}
              {page === "Projects" && (
                <div className="projects-list">
                  {state.projects.length ? (
                    state.projects.map((p, i) => (
                      <section className="panel project-card" key={p.id}>
                        <span className={`project-icon color-${i % 5}`}>
                          <Folder size={22} />
                        </span>
                        <div>
                          <h2>{p.name}</h2>
                          <p>{p.description || "Local Git repository"}</p>
                          <code>{p.path}</code>
                          {p.error && <p className="red">{p.error}</p>}
                        </div>
                        <div className="project-actions">
                          <Badge status={p.status} />
                          <small>
                            {
                              state.agents.filter((a) => a.projectId === p.id)
                                .length
                            }{" "}
                            workers
                          </small>
                          <button
                            onClick={() => {
                              setProjectId(p.id);
                              navigate("Command Center");
                            }}
                          >
                            Open workspace <ArrowUpRight size={14} />
                          </button>
                        </div>
                      </section>
                    ))
                  ) : (
                    <Empty
                      icon={Folder}
                      title="Make room for your next project"
                      text="Connect an existing Git repository to start building your team."
                      action="Add project"
                      onClick={() => setModal("project")}
                    />
                  )}
                </div>
              )}
              {page === "Runs" && (
                <section className="panel">{activity()}</section>
              )}
              {page === "Agent Messages" &&
                taskRows(tasks.filter((t) => t.sender))}
              {page === "Usage" && (
                <>
                  <div className="overview-strip">
                    <div>
                      <span>
                        <strong>
                          {tasks.filter((t) => t.status === "COMPLETED").length}
                        </strong>
                        <small>Completed sessions</small>
                      </span>
                    </div>
                    <div>
                      <span>
                        <strong>
                          {tasks
                            .reduce((n, t) => n + (t.inputTokens || 0), 0)
                            .toLocaleString()}
                        </strong>
                        <small>Reported input tokens</small>
                      </span>
                    </div>
                    <div>
                      <span>
                        <strong>
                          {tasks
                            .reduce((n, t) => n + (t.outputTokens || 0), 0)
                            .toLocaleString()}
                        </strong>
                        <small>Reported output tokens</small>
                      </span>
                    </div>
                    <div>
                      <span>
                        <strong>
                          {Math.round(
                            tasks.reduce((n, t) => n + (t.durationMs || 0), 0) /
                              60000,
                          )}
                          m
                        </strong>
                        <small>Runtime duration</small>
                      </span>
                    </div>
                  </div>
                  <section className="panel">
                    <h2>Connected through Claude Code</h2>
                    <p className="subtle">
                      Usage comes from actual runtime results. Subscription
                      limits and billing remain with your Claude account. Token
                      totals here cover the latest attempt of each task and
                      exclude cache tokens.
                    </p>
                  </section>
                  {taskRows(tasks.filter((t) => t.durationMs))}
                </>
              )}
              {page === "Settings" && (
                <>
                  <section className="panel settings-panel">
                    <div>
                      <Terminal size={22} />
                      <h2>Local runtime</h2>
                      <p>
                        Your repositories and Claude Code sessions run on this
                        machine.
                      </p>
                      <dl>
                        <dt>Connection</dt>
                        <dd>
                          {state.bridge.connected
                            ? "Connected"
                            : "Disconnected"}
                        </dd>
                        <dt>Machine</dt>
                        <dd>{state.bridge.hostname || "Not connected"}</dd>
                        <dt>Claude Code</dt>
                        <dd>{state.bridge.version || "Not detected"}</dd>
                        <dt>Authentication</dt>
                        <dd>Your existing Claude Code login</dd>
                      </dl>
                      <button onClick={() => setModal("connect")}>
                        Connection instructions
                      </button>
                    </div>
                    <div>
                      <ShieldCheck size={22} />
                      <h2>Workspace boundaries</h2>
                      <p>
                        Every worker has a dedicated Git worktree. File tools
                        are restricted to that worktree.
                      </p>
                      <p>
                        Tests and commits require your approval. Approved test
                        scripts run with your operating system permissions.
                        Production deployment is not supported.
                      </p>
                      <p>
                        Memory is stored in <code>.agents/</code> inside each
                        project; task and event records are stored locally in
                        SQLite.
                      </p>
                    </div>
                  </section>
                </>
              )}
            </>
          )}
        </main>
        <footer className="command-dock">
          <div className="command-box">
            <span className="command-icon">
              <Command size={19} />
            </span>
            <textarea
              ref={commandRef}
              aria-label="Team command"
              placeholder="What should your team work on?"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void runCommand();
                }
              }}
              rows={1}
            />
            <select
              aria-label="Assign command to worker"
              value={commandAgent}
              onChange={(e) => setCommandAgent(e.target.value)}
            >
              <option value="">
                {agents.length ? "Select worker" : "No workers yet"}
              </option>
              {agents
                .filter((a) => a.workspace)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </select>
            <button
              className="send-button"
              disabled={busy || !command.trim()}
              aria-label="Assign task"
              onClick={() => void runCommand()}
            >
              <ArrowUpRight size={18} />
            </button>
          </div>
          <div className="command-hint">
            <span>One instruction. Your team takes it from here.</span>
            <span>
              <kbd>⌘ K</kbd> to focus <span>·</span> <kbd>↵</kbd> to assign
            </span>
          </div>
        </footer>
      </div>
      {notice && (
        <div className="toast" role="status">
          <Check size={16} />
          {notice}
        </div>
      )}
      {(modal || selectedTask) && (
        <div
          className="modal-overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) {
              setModal(null);
              setSelectedTask(null);
            }
          }}
        >
          <div
            className={`modal ${selectedTask && !modal ? "wide" : ""}`}
            role="dialog"
            aria-modal="true"
            aria-label={modal || "Task details"}
          >
            <button
              className="modal-close icon-button"
              aria-label="Close dialog"
              onClick={() => {
                setModal(null);
                setSelectedTask(null);
              }}
            >
              <X size={18} />
            </button>
            {modal === "connect" ? (
              <>
                <span className="modal-icon">
                  <Terminal size={24} />
                </span>
                <h2>Connect your machine</h2>
                <p>Keep the local bridge running while your team works.</p>
                <div className="instruction-step">
                  <span>1</span>
                  <div>
                    <strong>Sign in to Claude Code</strong>
                    <p>Use the official CLI with your Claude account.</p>
                    <code>claude auth login</code>
                  </div>
                </div>
                <div className="instruction-step">
                  <span>2</span>
                  <div>
                    <strong>Start the bridge</strong>
                    <p>From the Crewline project folder, in a new terminal:</p>
                    <code>npm run connect</code>
                  </div>
                </div>
                <div
                  className={`runtime-state ${state.bridge.connected ? "green" : ""}`}
                >
                  <span className="dot" />
                  {state.bridge.connected
                    ? `Connected · ${state.bridge.hostname}`
                    : "Waiting for your local runtime"}
                </div>
                <p className="fine-print">
                  The bridge uses your existing Claude Code authentication.
                  Crewline never reads or copies Claude credentials.
                </p>
              </>
            ) : modal === "project" ? (
              <>
                <span className="modal-icon">
                  <Folder size={24} />
                </span>
                <h2>Add a project</h2>
                <p>
                  Start with a local Git repository that has at least one
                  commit.
                </p>
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const d = new FormData(e.currentTarget);
                    try {
                      await act(
                        "projects",
                        Object.fromEntries(d),
                        "Project added — validating repository",
                      );
                      setModal(null);
                    } catch {}
                  }}
                >
                  <label>
                    Project name
                    <input
                      name="name"
                      placeholder="RaahAI"
                      required
                      maxLength={80}
                      autoFocus
                    />
                  </label>
                  <label>
                    Repository path
                    <input
                      name="path"
                      placeholder="/Users/you/Projects/raah"
                      required
                    />
                  </label>
                  <label>
                    Project context
                    <textarea
                      name="description"
                      placeholder="What are you building? What should every worker know?"
                      rows={3}
                    />
                  </label>
                  {!state.bridge.connected && (
                    <p className="form-note amber">
                      Connect the local runtime before adding a project.
                    </p>
                  )}
                  <button
                    className="primary full"
                    disabled={busy || !state.bridge.connected}
                  >
                    Add project <ArrowRight size={15} />
                  </button>
                </form>
              </>
            ) : modal === "agent" ? (
              <>
                <span className="modal-icon">
                  <Users size={24} />
                </span>
                <h2>Create a worker</h2>
                <p>A clear role. A dedicated workspace. Memory that lasts.</p>
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const d = new FormData(e.currentTarget);
                    try {
                      await act(
                        "agents",
                        {
                          name: d.get("name"),
                          role: d.get("role"),
                          responsibility: d.get("responsibility"),
                          projectId: d.get("projectId"),
                          permissions: Object.fromEntries(
                            ["read", "write", "tests", "git"].map((k) => [
                              k,
                              d.get(k) === "on",
                            ]),
                          ),
                        },
                        "Worker created — preparing its worktree",
                      );
                      setModal(null);
                    } catch {}
                  }}
                >
                  <div className="form-columns">
                    <label>
                      Name
                      <input
                        name="name"
                        placeholder="Backend"
                        required
                        maxLength={60}
                        autoFocus
                      />
                    </label>
                    <label>
                      Role
                      <input
                        name="role"
                        placeholder="Backend Engineer"
                        required
                        maxLength={100}
                      />
                    </label>
                  </div>
                  <label>
                    Responsibility
                    <textarea
                      name="responsibility"
                      placeholder="Build and maintain the APIs, database, and backend tests."
                      rows={3}
                      required
                    />
                  </label>
                  <label>
                    Project
                    <select
                      name="projectId"
                      defaultValue={
                        projectId !== "all"
                          ? projectId
                          : state.projects.find((p) => p.status === "ready")?.id
                      }
                      required
                    >
                      <option value="">Choose a project</option>
                      {state.projects
                        .filter((p) => p.status === "ready")
                        .map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <fieldset>
                    <legend>Permissions</legend>
                    {[
                      ["read", "Read repository"],
                      ["write", "Modify assigned workspace"],
                      ["tests", "Run tests · approval required"],
                      ["git", "Git · commits require approval"],
                    ].map(([key, label]) => (
                      <label className="checkbox" key={key}>
                        <input type="checkbox" name={key} defaultChecked />
                        {label}
                      </label>
                    ))}
                  </fieldset>
                  {!state.projects.some((p) => p.status === "ready") && (
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => setModal("project")}
                    >
                      Add a project first <ArrowRight size={14} />
                    </button>
                  )}
                  <button
                    className="primary full"
                    disabled={
                      busy ||
                      !state.bridge.connected ||
                      !state.projects.some((p) => p.status === "ready")
                    }
                  >
                    Create worker <Plus size={15} />
                  </button>
                </form>
              </>
            ) : modal === "task" || modal === "handoff" ? (
              <>
                <span className="modal-icon">
                  {modal === "handoff" ? (
                    <Workflow size={24} />
                  ) : (
                    <ListTodo size={24} />
                  )}
                </span>
                <h2>
                  {modal === "handoff"
                    ? "Pass the work forward"
                    : "Give your worker a task"}
                </h2>
                <p>
                  {modal === "handoff"
                    ? "Share the context and define what happens next."
                    : "A simple instruction is enough. We’ll add the project and worker context."}
                </p>
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const d = new FormData(e.currentTarget);
                    try {
                      const dep = d.get("dependency");
                      await act(
                        "tasks",
                        {
                          agent: d.get("agent"),
                          title: d.get("title"),
                          description: d.get("description"),
                          dependencies:
                            modal === "handoff" && selectedTask
                              ? [selectedTask.id]
                              : dep
                                ? [dep]
                                : [],
                          ...(modal === "handoff" && selectedTask
                            ? {
                                sender: selectedTask.agent,
                                parent_task: selectedTask.id,
                                context: `${d.get("context")}\nCommit: ${selectedTask.git_commit || "Not recorded"}`,
                                expected_output: d.get("expected_output"),
                              }
                            : {}),
                        },
                        "Task queued",
                      );
                      setModal(null);
                      setSelectedTask(null);
                    } catch {}
                  }}
                >
                  <label>
                    {modal === "handoff" ? "Send to" : "Worker"}
                    <select
                      name="agent"
                      required
                      defaultValue={
                        modal === "handoff"
                          ? ""
                          : commandAgent ||
                            agent?.id ||
                            agents.find((a) => a.workspace)?.id
                      }
                    >
                      <option value="">Choose a worker</option>
                      {agents
                        .filter(
                          (a) =>
                            a.workspace &&
                            (modal !== "handoff" ||
                              a.id !== selectedTask?.agent),
                        )
                        .map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name} — {a.role}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    Task
                    <input
                      name="title"
                      required
                      placeholder="Implement Google login"
                      maxLength={300}
                      autoFocus
                    />
                  </label>
                  <label>
                    Details
                    <textarea
                      name="description"
                      rows={3}
                      placeholder="What does success look like? Any constraints?"
                    />
                  </label>
                  {modal === "handoff" ? (
                    <>
                      <label>
                        Context
                        <textarea
                          name="context"
                          rows={3}
                          defaultValue={
                            selectedTask?.result || selectedTask?.description
                          }
                        />
                      </label>
                      <label>
                        Expected output
                        <input
                          name="expected_output"
                          placeholder="Authentication test results"
                        />
                      </label>
                      <p className="form-note">
                        This task starts after the source task completes.
                      </p>
                    </>
                  ) : (
                    <label>
                      Wait for task <span className="subtle">(optional)</span>
                      <select name="dependency">
                        <option value="">No dependency</option>
                        {tasks.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.title}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <button
                    className="primary full"
                    disabled={busy || !agents.some((a) => a.workspace)}
                  >
                    Assign task <ArrowRight size={15} />
                  </button>
                </form>
              </>
            ) : selectedTask ? (
              <>
                <span className="eyebrow">
                  Task {selectedTask.id.slice(0, 8)}
                </span>
                <h2>{selectedTask.title}</h2>
                <Badge
                  status={
                    state.tasks.find((t) => t.id === selectedTask.id)?.status ||
                    selectedTask.status
                  }
                />
                <p>{selectedTask.description}</p>
                <dl>
                  <dt>Worker</dt>
                  <dd>
                    {
                      state.agents.find((a) => a.id === selectedTask.agent)
                        ?.name
                    }
                  </dd>
                  <dt>Dependencies</dt>
                  <dd>
                    {selectedTask.dependencies
                      .map(
                        (id) =>
                          state.tasks.find((t) => t.id === id)?.title || id,
                      )
                      .join(", ") || "None"}
                  </dd>
                  {selectedTask.context && (
                    <>
                      <dt>Context</dt>
                      <dd className="preserve">{selectedTask.context}</dd>
                    </>
                  )}
                  {selectedTask.expected_output && (
                    <>
                      <dt>Expected output</dt>
                      <dd>{selectedTask.expected_output}</dd>
                    </>
                  )}
                </dl>
                <div className="latest-output">
                  <span className="eyebrow">Output</span>
                  <pre>
                    {state.tasks.find((t) => t.id === selectedTask.id)
                      ?.result || "No output yet."}
                  </pre>
                </div>
                <div className="button-row">
                  {["RUNNING", "NEEDS_APPROVAL"].includes(
                    state.tasks.find((t) => t.id === selectedTask.id)?.status ||
                      "",
                  ) && (
                    <button
                      onClick={() =>
                        action(`tasks/${selectedTask.id}/pause`, {})
                      }
                    >
                      <Pause size={14} />
                      Pause
                    </button>
                  )}
                  {["WAITING", "FAILED"].includes(
                    state.tasks.find((t) => t.id === selectedTask.id)?.status ||
                      "",
                  ) && (
                    <button
                      onClick={() =>
                        action(`tasks/${selectedTask.id}/resume`, {})
                      }
                    >
                      <Play size={14} />
                      Resume
                    </button>
                  )}
                  <button onClick={() => setModal("handoff")}>
                    <ArrowUpRight size={14} />
                    Create handoff
                  </button>
                </div>
              </>
            ) : null}
            {error && (
              <p className="red" role="alert">
                {error}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
function Empty({
  icon: Icon,
  title,
  text,
  action,
  onClick,
}: {
  icon: React.ElementType;
  title: string;
  text: string;
  action: string;
  onClick: () => void;
}) {
  return (
    <div className="empty">
      <Icon size={30} />
      <h2>{title}</h2>
      <p>{text}</p>
      <button onClick={onClick}>
        <Plus size={15} />
        {action}
      </button>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
