#!/usr/bin/env node
// Test-only runtime fixture. Never selected by the application by default.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
if (process.argv.includes("--version")) {
  console.log("test-fixture-only");
  process.exit(0);
}
const args = process.argv.slice(2),
  config = JSON.parse(args[args.indexOf("--mcp-config") + 1]).mcpServers
    .crewline;
let prompt = "";
for await (const c of process.stdin) prompt += c;
const client = new Client({ name: "crewline-test", version: "1.0.0" });
await client.connect(
  new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: { ...process.env, ...config.env },
  }),
);
process.on("SIGTERM", () => {
  void client.close().finally(() => process.exit(143));
});
const tool = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.map((c) => c.text || "").join("");
  if (result.isError) throw new Error(text);
  return JSON.parse(text);
};
const emit = (x) => console.log(JSON.stringify(x));
emit({ type: "system", session_id: "fixture-session" });
try {
  if (prompt.includes("Task: Consume handoff fixture")) {
    const commit = prompt.match(/Transfer commit: ([a-f0-9]{40})/)[1];
    await tool("integrate_commit", { commit });
    const contents = await tool("read_file", { path: "handoff.txt" });
    if (contents !== "Verified handoff")
      throw new Error("Handoff contents not transferred");
  } else if (prompt.includes("Task: Produce handoff fixture")) {
    await tool("write_file", {
      path: "handoff.txt",
      content: "Verified handoff",
    });
    const { commit } = await tool("commit", { message: "Fixture handoff" });
    const recipient = (await tool("list_workers", {})).find(
      (a) => a.name === "QA",
    );
    await tool("handoff", {
      recipient: recipient.id,
      title: "Consume handoff fixture",
      objective: "Integrate and verify the handoff",
      context: `Transfer commit: ${commit}`,
      expected_output: "Verified handoff contents",
    });
  } else {
    await tool("write_file", {
      path: "fixture-output.txt",
      content: "Verified isolated worker output",
    });
    emit({
      type: "stream_event",
      event: { delta: { text: "Checking the isolated workspace. " } },
    });
    await tool("run_tests", {});
    await tool("save_memory", {
      memory: "Remember: fixture test passed.",
      progress: "Work verified.",
    });
  }
  emit({
    type: "result",
    result: "Integration fixture completed.",
    is_error: false,
    usage: { input_tokens: 10, output_tokens: 7 },
  });
} catch (e) {
  emit({ type: "result", is_error: true, result: e.message });
  process.exitCode = 1;
} finally {
  await client.close();
}
