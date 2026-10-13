import { useState, type ReactNode } from "react";
import {
  Activity,
  ArrowUpRight,
  Check,
  ChevronRight,
  Folder,
  GitBranch,
  ListTodo,
  Plus,
  Search,
  Terminal,
  Users,
} from "lucide-react";
import type { Agent, Project, Snapshot, Task } from "../shared/types";

type Props = {
  state: Snapshot;
  project?: Project;
  agents: Agent[];
  tasks: Task[];
  onProject: () => void;
  onAgent: () => void;
  onConnect: () => void;
  onOpenAgent: (agent: Agent) => void;
  onTask: (task: Task) => void;
  renderTasks: (tasks: Task[]) => ReactNode;
  renderActivity: () => ReactNode;
  approvals: ReactNode;
};

export function WorkspaceOverview({
  state,
  project,
  agents,
  tasks,
  onProject,
  onAgent,
  onConnect,
  onOpenAgent,
  onTask,
  renderTasks,
  renderActivity,
  approvals,
}: Props) {
  const [view, setView] = useState<"Workers" | "Tasks" | "Activity">("Workers");
  const [query, setQuery] = useState("");
  const readyProject = project
    ? project.status === "ready"
    : state.projects.some((p) => p.status === "ready");
  const running = tasks.filter((t) => t.status === "RUNNING").length;
  const waiting = tasks.filter((t) => t.status === "NEEDS_APPROVAL").length;
  const visible = agents.filter((a) =>
    `${a.name} ${a.role}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className="workbench">
      <section className="workbench-main">
        <div className="workbench-heading">
          <div>
            <h1>{project?.name || "Workspace"}</h1>
            <span>
              {agents.length} workers<span className="separator">/</span>
              {running} running
              {waiting > 0 && (
                <span className="attention-count">
                  {waiting} awaiting approval
                </span>
              )}
            </span>
          </div>
          <button
            onClick={
              !state.bridge.connected
                ? onConnect
                : readyProject
                  ? onAgent
                  : onProject
            }
          >
            <Plus size={14} />
            {!state.bridge.connected
              ? "Connect runtime"
              : readyProject
                ? "New worker"
                : "Add repository"}
          </button>
        </div>
        <div
          className="workbench-tabs"
          role="tablist"
          aria-label="Workspace view"
        >
          {(["Workers", "Tasks", "Activity"] as const).map((v) => (
            <button
              key={v}
              role="tab"
              id={`workspace-tab-${v}`}
              aria-controls="workspace-panel"
              tabIndex={view === v ? 0 : -1}
              onKeyDown={(event) => {
                const views = ["Workers", "Tasks", "Activity"] as const;
                const index = views.indexOf(v);
                const next =
                  event.key === "ArrowRight"
                    ? (index + 1) % 3
                    : event.key === "ArrowLeft"
                      ? (index + 2) % 3
                      : event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? 2
                          : -1;
                if (next < 0) return;
                event.preventDefault();
                setView(views[next]);
                document
                  .getElementById(`workspace-tab-${views[next]}`)
                  ?.focus();
              }}
              aria-selected={view === v}
              onClick={() => setView(v)}
            >
              {v}
              {v !== "Activity" && (
                <span>{v === "Workers" ? agents.length : tasks.length}</span>
              )}
            </button>
          ))}
          <div className="workbench-search" hidden={!agents.length}>
            <Search size={13} />
            <input
              aria-label="Search workspace workers"
              placeholder="Filter workers"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setView("Workers");
              }}
            />
          </div>
        </div>
        <div
          className="workbench-content"
          role="tabpanel"
          id="workspace-panel"
          aria-labelledby={`workspace-tab-${view}`}
        >
          {approvals}
          {view === "Workers" &&
            (agents.length > 0 ? (
              <div className="worker-register">
                <div className="register-heading">
                  <span>Worker</span>
                  <span>Latest task</span>
                  <span>Status</span>
                </div>
                {visible.map((a) => {
                  const owned = tasks.filter((t) => t.agent === a.id);
                  const task =
                    owned.find((t) =>
                      ["RUNNING", "NEEDS_APPROVAL", "WAITING"].includes(
                        t.status,
                      ),
                    ) || owned.at(-1);
                  const status = task?.status || a.status;
                  return (
                    <button
                      className="worker-register-row"
                      key={a.id}
                      onClick={() => onOpenAgent(a)}
                    >
                      <span className="worker-identity">
                        <Users size={15} />
                        <span>
                          <strong>{a.name}</strong>
                          <small>{a.role}</small>
                        </span>
                      </span>
                      <span className="worker-task-title">
                        {a.error || task?.title || "No task assigned"}
                      </span>
                      <span
                        className={`register-status status-${status.toLowerCase()}`}
                      >
                        <i />
                        {(
                          {
                            RUNNING: "Running",
                            NEEDS_APPROVAL: "Needs approval",
                            WAITING: "Paused",
                            COMPLETED: "Available",
                            QUEUED: "Queued",
                            BLOCKED: "Blocked",
                            FAILED: "Failed",
                            ready: "Available",
                            preparing: "Preparing",
                            error: "Error",
                          } as Record<string, string>
                        )[status] || status}
                        <ChevronRight size={12} />
                      </span>
                    </button>
                  );
                })}
                {visible.length === 0 && (
                  <p className="no-matches">No workers match “{query}”.</p>
                )}
              </div>
            ) : (
              <div className="workspace-empty">
                <div className="empty-repo-icon">
                  <Folder size={24} />
                </div>
                <h2>
                  {!state.bridge.connected
                    ? "Connect your local runtime"
                    : readyProject
                      ? "Create your first worker"
                      : "Add a repository to get started"}
                </h2>
                <p>
                  {!state.bridge.connected
                    ? "Start the local bridge to connect repositories and run workers on your machine."
                    : readyProject
                      ? "Give a worker a responsibility and assign its first task. Each worker gets a separate Git worktree."
                      : "Connect a local Git repository, then create workers to run Claude Code in separate worktrees."}
                </p>
                <button
                  onClick={
                    !state.bridge.connected
                      ? onConnect
                      : readyProject
                        ? onAgent
                        : onProject
                  }
                >
                  <Plus size={14} />
                  {!state.bridge.connected
                    ? "Connect runtime"
                    : readyProject
                      ? "New worker"
                      : "Add repository"}
                </button>
                <div className="empty-shortcut">
                  <kbd>⌘ K</kbd>
                  <span>Focus task input</span>
                </div>
              </div>
            ))}
          {view === "Tasks" && renderTasks(tasks)}
          {view === "Activity" && renderActivity()}
        </div>
        {tasks.length > 0 && view === "Workers" && (
          <div className="recent-work">
            <h2>Recent tasks</h2>
            {[...tasks]
              .reverse()
              .slice(0, 4)
              .map((t) => (
                <button key={t.id} onClick={() => onTask(t)}>
                  <ListTodo size={13} />
                  <span>{t.title}</span>
                  <ArrowUpRight size={12} />
                </button>
              ))}
          </div>
        )}
      </section>
      <aside className="workspace-inspector" aria-label="Workspace details">
        <div className="inspector-title">Workspace details</div>
        <section>
          <h2>
            <Folder size={13} />
            Repository
          </h2>
          {project ? (
            <>
              <strong>{project.name}</strong>
              <code>{project.path}</code>
              <div className="inspector-inline">
                <GitBranch size={12} />
                {project.status === "ready"
                  ? "Git repository connected"
                  : project.status}
              </div>
            </>
          ) : (
            <>
              <p>
                {state.projects.length
                  ? `${state.projects.length} repositories connected. Select one in the sidebar to view its details.`
                  : "No repository selected."}
              </p>
              <button className="inspector-link" onClick={onProject}>
                Add repository
                <Plus size={12} />
              </button>
            </>
          )}
        </section>
        <section>
          <h2>
            <Terminal size={13} />
            Runtime
          </h2>
          <div className="inspector-kv">
            <span>Provider</span>
            <strong>
              {state.bridge.claude ? "Claude Code" : "Not detected"}
            </strong>
          </div>
          <div className="inspector-kv">
            <span>Bridge</span>
            <strong className={state.bridge.connected ? "runtime-online" : ""}>
              <i />
              {state.bridge.connected ? "Connected" : "Offline"}
            </strong>
          </div>
          {state.bridge.version && <code>{state.bridge.version}</code>}
          <p className="runtime-auth-note">
            Bridge status does not verify Claude sign-in.
          </p>
          <button className="inspector-link" onClick={onConnect}>
            Connection details
            <ArrowUpRight size={12} />
          </button>
        </section>
        <section>
          <h2>
            <GitBranch size={13} />
            Workspace setup
          </h2>
          <ol className="setup-checklist">
            <li className={state.bridge.connected ? "complete" : ""}>
              {state.bridge.connected ? (
                <Check size={12} />
              ) : (
                <span className="check-outline" />
              )}
              <button onClick={onConnect}>Connect local runtime</button>
            </li>
            <li className={readyProject ? "complete" : ""}>
              {readyProject ? (
                <Check size={12} />
              ) : (
                <span className="check-outline" />
              )}
              <button onClick={onProject}>Add a repository</button>
            </li>
            <li className={agents.length ? "complete" : ""}>
              {agents.length ? (
                <Check size={12} />
              ) : (
                <span className="check-outline" />
              )}
              <button onClick={onAgent}>Create a worker</button>
            </li>
          </ol>
        </section>
        <div className="inspector-footer">
          <Activity size={12} />
          <span>Tasks and memory saved locally</span>
        </div>
      </aside>
    </div>
  );
}
