import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
const server = new McpServer({ name: "crewline", version: "0.1.0" });
const call = async (tool: string, args: unknown) => {
  try {
    const res = await fetch(`${process.env.CREWLINE_ENDPOINT}/tool`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.CREWLINE_RUN_TOKEN}`,
      },
      body: JSON.stringify({ tool, args }),
    });
    const data = (await res.json()) as any;
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data) }],
      isError: !res.ok,
    };
  } catch (e) {
    return {
      content: [{ type: "text" as const, text: String(e) }],
      isError: true,
    };
  }
};
server.tool(
  "list_files",
  "List files in your assigned worktree.",
  { path: z.string().default(".") },
  (args) => call("list_files", args),
);
server.tool(
  "read_file",
  "Read a UTF-8 file in your assigned worktree.",
  { path: z.string() },
  (args) => call("read_file", args),
);
server.tool(
  "write_file",
  "Create or replace a UTF-8 file in your assigned worktree.",
  { path: z.string(), content: z.string().max(500000) },
  (args) => call("write_file", args),
);
server.tool(
  "git_inspect",
  "Inspect your worktree changes or recent commits.",
  { operation: z.enum(["status", "diff", "log"]) },
  (args) => call("git_inspect", args),
);
server.tool(
  "run_tests",
  "Request approval to run the repository npm test script. The exact script is shown to the user.",
  {},
  (args) => call("run_tests", args),
);
server.tool(
  "commit",
  "Request human approval to stage changes and create a commit on your worker branch.",
  { message: z.string().min(1).max(500) },
  (args) => call("commit", args),
);
server.tool(
  "integrate_commit",
  "Request approval to cherry-pick a handoff commit from another worker in this project into your clean worktree.",
  { commit: z.string().regex(/^[a-f0-9]{40}$/) },
  (args) => call("integrate_commit", args),
);
server.tool(
  "save_memory",
  "Save durable findings and remaining work outside the session context.",
  { memory: z.string().max(50000), progress: z.string().max(50000) },
  (args) => call("save_memory", args),
);
server.tool(
  "list_workers",
  "List workers available for handoff in this project.",
  {},
  (args) => call("list_workers", args),
);
server.tool(
  "handoff",
  "Create a follow-up task for another worker; it waits for your current task to complete. Include commit and integration instructions in context.",
  {
    recipient: z.string(),
    title: z.string().max(300),
    objective: z.string().max(20000),
    context: z.string().max(20000),
    expected_output: z.string().max(5000),
  },
  (args) => call("handoff", args),
);
await server.connect(new StdioServerTransport());
