# Crewline

A local command center for persistent Claude Code workers. This is a working V0 codebase, not a seeded activity demo.

**Project location:** `/Users/vibhumaggarwal/Projects/crewline`

## Start here

Requires Node **22.13+**, Git, npm, and a recent official Claude Code installation. Node's built-in SQLite may print an experimental warning on some versions; that is expected.

```sh
cd /Users/vibhumaggarwal/Projects/crewline
npm install
npm run dev
```

In a second terminal, from the same folder:

```sh
claude auth login
npm run login
npm run connect
```

`npm run login` opens an authenticated local browser link on macOS (prints it on other systems). The app is at **http://127.0.0.1:4317**. Keep the coordinator and bridge terminals running. The bridge does not extract, copy, or store Claude credentials; Claude Code uses its own existing official authentication.

1. Add a project with the absolute path of an existing local Git repository. It must have at least one commit.
2. Create a worker with a role, responsibility, project, and permissions.
3. Select the worker in the bottom command input and assign a task.
4. Open the worker to see output, task history, durable memory, and activity.
5. Review test/commit approval cards in the command center. Approval expires after five minutes.
6. Use **Create handoff** on a task to assign a dependent task to another worker. Workers can also request handoffs through the coordinator tool.

The app starts empty. No projects, workers, live activity, progress percentages, or usage are fabricated.

## Commands

| Command           | Purpose                                                                         |
| ----------------- | ------------------------------------------------------------------------------- |
| `npm run dev`     | Coordinator + Vite development UI, bound to loopback                            |
| `npm run connect` | Local Claude/worktree bridge                                                    |
| `npm run login`   | Open a local authenticated browser session                                      |
| `npm run build`   | Type-check all source and build the UI                                          |
| `npm start`       | Serve the built application locally                                             |
| `npm test`        | Boundary, scheduling, Git, and full local bridge integration tests; build first |
| `npm run format`  | Format source files                                                             |

## Appearance

The interface takes visual inspiration from [America.gov](https://america.gov/): serif headings, a navy accent, soft gray surfaces, and a prominent rounded command input. Use the sun/moon button in the header to switch between light and dark. The choice is saved on this device. Visual tokens and appearance overrides live in `src/theme.css`; base component layout remains in `src/style.css`.

## Architecture and source map

```text
React browser UI
  ├─ HTTP commands → authenticated coordinator
  └─ SSE snapshots ← SQLite state and runtime events
                           │
                   authenticated WebSocket
                           │
                      local CLI bridge
                       ├─ Git worktrees
                       ├─ durable .agents files
                       └─ ClaudeCodeRuntime → official claude -p
                              └─ scoped MCP tools → bridge loopback endpoint
```

| File                    | Responsibility                                                                   |
| ----------------------- | -------------------------------------------------------------------------------- |
| `src/main.tsx`          | Navigation, command center, forms, worker details, approvals, task/handoff views |
| `src/style.css`         | Base component layout and responsive behavior                                       |
| `shared/types.ts`       | Shared project, worker, task, approval and event contracts                       |
| `server/index.ts`       | Loopback HTTP/SSE server, local authentication, WebSocket bridge connection      |
| `server/coordinator.ts` | Task lifecycle, dependency scheduling, worker serialization, handoff routing     |
| `server/store.ts`       | SQLite persistent record store (WAL)                                             |
| `bridge/cli.ts`         | CLI connection, process lifecycle, approvals, file/test/Git/memory tool handlers |
| `bridge/runtime.ts`     | Provider interface and Claude Code subprocess adapter                            |
| `bridge/workspace.ts`   | Git worktrees, path boundaries, durable context construction                     |
| `bridge/tools.ts`       | MCP tool descriptions and transport adapter used by Claude                       |
| `tests/`                | Unit and integration tests; fake Claude is test-only                             |

The provider interface is intentionally small. Only Claude Code is implemented. Its event callback supplies streaming output; start/send/resume use new sessions reconstructed from persistent context rather than depending on an immortal conversation.

## Persistent state

Application state, local login credential and worktrees are stored under ignored `.crewline/`:

```text
.crewline/
  credentials.json       # local application credential; never commit or share
  crewline.sqlite        # projects, workers, tasks, events and approvals
  worktrees/<project-id>/<worker-id>/
```

Each connected project stores human-readable context outside the Claude session:

```text
<repository>/.agents/
  project.md
  <worker-id>/
    identity.md
    memory.md
    progress.md
    tasks/<task-id>.json
```

Worker IDs are stable, so duplicate display names across projects cannot collide. Memory updates are saved through a tool or the UI. Final task results and progress are written automatically. Resume constructs a new prompt from project context, identity, memory, progress, task details and Git status. Existing `project.md` is preserved.

Keep `.agents/` private if it contains sensitive context. The worker commit tool excludes `.agents/` and `.claude/`. Decide separately whether your team wants to version these files. Back up the SQLite database and memory files with the processes stopped. Worktrees reference the original repository; do not move repositories or delete `.crewline/worktrees` blindly.

## Execution and trust boundaries

- Single user, local-first V0. HTTP and bridge endpoints bind to `127.0.0.1`; remote hosting, accounts, billing and deployment are deliberately absent.
- Browser APIs require a local credential, use an HttpOnly SameSite cookie, validate local hosts, and reject foreign browser origins. The bridge authenticates with the same application credential. This is unrelated to Claude authentication.
- Claude's native tools are disabled for worker sessions. Only the scoped Crewline MCP tools are enabled. Ambient MCP servers, settings sources and hooks are disabled.
- File operations reject absolute paths, traversal, symlinks and protected `.git`, `.agents`, `.claude` paths. Permissions are enforced by the bridge, not just by prompting.
- Worktrees isolate Git branches and changes. **They are not OS sandboxes.** Approved npm test scripts run with the user's OS permissions. The UI shows the actual test/pretest/posttest scripts. Review project code before approving execution.
- There is no arbitrary shell endpoint. The V0 command tools are fixed operations: npm test, Git inspection, an approved commit, and approved handoff cherry-picks. Commit hooks and signing are disabled for worker commits. No push, merge-to-main or deployment tool is exposed.
- Pause terminates the Claude process, rejects pending approvals, and stops any active test process group. Resume starts a fresh session from durable context. A disconnection or coordinator restart leaves interrupted tasks paused for explicit resumption.
- Multiple workers can run concurrently, but each worker runs one task at a time. A paused worker holds its queue. Dependency tasks only run after every predecessor completes successfully.

## V0 limits and continuation work

1. **Live Claude verification requires login.** At implementation time the installed official CLI reported `loggedIn: false`. Integration tests exercise the real coordinator, bridge, worktrees, HTTP, WebSocket, MCP transport, approval and memory paths using a test-only executable; they do not prove a live model response. After signing in, assign a tiny file-writing task and verify the tools in your Claude version.
2. Tests currently support the repository's `npm test` script. Dependencies are not auto-installed into worktrees. Install the project's dependencies locally before approving tests; Python/Go/custom runners need explicit adapters.
3. Handoffs transfer task context, dependencies, source branch and commit information. They do not silently merge branches. The receiving worker can request `integrate_commit` approval to cherry-pick the provided full commit SHA into its clean worktree. Conflicting cherry-picks are aborted, leaving conflict resolution to the user.
4. No arbitrary terminal, file deletion tool, network fetch tool, package installer, diff review/merge UI, or automatic planner yet. The worker can list, read and write files, inspect Git, request tests/commit, persist memory, create handoffs, and request handoff commit integration.
5. Task results and usage show the latest attempt. Events and final task files are retained, but a separate normalized run-attempt ledger and retention/compaction policy would be the next persistence improvement. File summaries include committed and uncommitted changes and are captured at run completion.
6. One local bridge connects to one coordinator. Authentication refresh is delegated to Claude. Moving to a hosted control plane would require per-device pairing, TLS, revocable device credentials and remote authorization; do not expose this loopback server publicly.
7. UI identity is currently the brief's Vibhum/personal workspace. There is no account system or settings editor.

## Verification

`npm run build` checks TypeScript and creates `dist/`. `npm test` uses temporary repositories and an isolated database; the integration server uses port 14317 and never writes fixture activity into your real workspace. It validates authentication, cross-origin rejection, project/worktree creation, output streaming, approval acceptance/rejection, memory persistence, task completion/failure, pause/resume during approval, and an approved commit handoff between two worktrees. Core tests cover path traversal/symlink denial, dependency scheduling, restart recovery and worktree isolation.

Official runtime reference: [Run Claude Code programmatically](https://code.claude.com/docs/en/headless).

## Environment

Optional `PORT` (default 4317), `CREWLINE_DATA` (default `.crewline` relative to the project folder), `CREWLINE_URL` (local coordinator URL for the bridge) and `CREWLINE_CLAUDE` (path to the official CLI, defaults to `claude`). Use the same data path in coordinator and bridge terminals. The executable override exists for installation differences and integration tests; production never automatically chooses the test fixture.
