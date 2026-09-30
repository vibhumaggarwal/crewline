export const statuses = [
  "CREATED",
  "QUEUED",
  "RUNNING",
  "BLOCKED",
  "WAITING",
  "COMPLETED",
  "FAILED",
  "NEEDS_APPROVAL",
] as const;
export type Status = (typeof statuses)[number];
export type Permissions = {
  read: boolean;
  write: boolean;
  tests: boolean;
  git: boolean;
};
export type Project = {
  id: string;
  name: string;
  path: string;
  description: string;
  created_at: string;
  status: string;
  error?: string;
};
export type Agent = {
  id: string;
  projectId: string;
  name: string;
  role: string;
  responsibility: string;
  permissions: Permissions;
  branch: string;
  workspace: string;
  status: string;
  memory: string;
  progress: string;
  error?: string;
};
export type Task = {
  id: string;
  projectId: string;
  title: string;
  description: string;
  agent: string;
  status: Status;
  created_at: string;
  updated_at: string;
  started_at?: string;
  dependencies: string[];
  parent_task?: string;
  sender?: string;
  context?: string;
  expected_output?: string;
  result?: string;
  git_commit?: string;
  files?: string[];
  sessionId?: string;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
};
export type Activity = {
  id: string;
  taskId?: string;
  agentId?: string;
  projectId?: string;
  kind: string;
  text: string;
  created_at: string;
  raw?: string;
};
export type Approval = {
  id: string;
  taskId: string;
  agentId: string;
  title: string;
  detail: string;
  status: "pending" | "approved" | "rejected" | "expired";
  created_at: string;
};
export type Snapshot = {
  projects: Project[];
  agents: Agent[];
  tasks: Task[];
  events: Activity[];
  approvals: Approval[];
  bridge: {
    connected: boolean;
    claude: boolean;
    version?: string;
    hostname?: string;
  };
};
